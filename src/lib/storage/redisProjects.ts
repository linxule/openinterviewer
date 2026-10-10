// Each operation is one EVAL. Preflight precedes every write: Redis Lua errors
// do not roll back earlier commands. No project operation writes study JSON.
import { RedisCommitAmbiguousError, type RedisPort } from '../redisPort';
import type { ProjectsStorePort, ProjectOutcome } from '../projects/types';
import { closed, isProjectId, isProjectOutcome, isStudyId, normalizeProjectName } from '../projects/validation';
import { STUDY_DELETION_GUARD_LUA } from './redisStudyGuard';

export const PROJECTS_SCRIPT = `
local op, id, name, studyId, now = ARGV[1], ARGV[2], ARGV[3], ARGV[4], tonumber(ARGV[5])
local function result(status) return {'oi:' .. status} end
local function kind(key, expected)
  local t = redis.call('TYPE', key).ok
  return t == 'none' or t == expected
end
local function uuid(v)
  return type(v) == 'string' and #v == 36 and string.match(v, '^%x%x%x%x%x%x%x%x%-%x%x%x%x%-4%x%x%x%-[89ab]%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x$') ~= nil
    and v == string.lower(v)
end
local function study_id(v)
  return type(v) == 'string' and #v > 0 and #v <= 128 and string.match(v, '^[A-Za-z0-9-]+$') ~= nil
end
local function integer(v) return type(v) == 'number' and v >= 0 and v <= 9007199254740991 and v == math.floor(v) end
local function valid_name(v)
  if type(v) ~= 'string' or #v == 0 or #v > 800 then return false end
  local n, i, first, last = 0, 1, nil, nil
  while i <= #v do
    local b = string.byte(v, i)
    local cp, size = b, 1
    if b >= 194 and b <= 223 then cp, size = b - 192, 2
    elseif b >= 224 and b <= 239 then cp, size = b - 224, 3
    elseif b >= 240 and b <= 244 then cp, size = b - 240, 4
    elseif b >= 128 then return false end
    for j=1,size-1 do
      local c = string.byte(v,i+j)
      if not c or c < 128 or c > 191 then return false end
      cp = cp * 64 + c - 128
    end
    if (size == 2 and cp < 128) or (size == 3 and cp < 2048) or (size == 4 and cp < 65536)
      or cp > 1114111 or (cp >= 55296 and cp <= 57343) or cp < 32 or (cp >= 127 and cp <= 159) then return false end
    first = first or cp; last = cp
    n = n + (cp > 65535 and 2 or 1); i = i + size
  end
  local function space(cp)
    return cp == 32 or cp == 160 or cp == 5760 or (cp >= 8192 and cp <= 8202)
      or cp == 8232 or cp == 8233 or cp == 8239 or cp == 8287 or cp == 12288 or cp == 65279
  end
  return n <= 200 and not space(first) and not space(last)
end
local function get_project(pid)
  if not uuid(pid) or not kind('project:' .. pid, 'string') then return nil, 'unavailable' end
  local raw = redis.call('GET', 'project:' .. pid)
  local indexed = redis.call('SISMEMBER', 'all-projects', pid) == 1
  if not raw then return nil, indexed and 'unavailable' or 'not-found' end
  if not indexed or #raw > 4096 or string.sub(raw,1,11) ~= 'oi:project:' then return nil, 'unavailable' end
  local ok, p = pcall(cjson.decode, string.sub(raw,12))
  if not ok or type(p) ~= 'table' or p.id ~= pid or not valid_name(p.name)
    or not integer(p.createdAt) or not integer(p.updatedAt) or p.updatedAt < p.createdAt then return nil, 'unavailable' end
  local fields = 0
  for k in pairs(p) do
    if k ~= 'id' and k ~= 'name' and k ~= 'createdAt' and k ~= 'updatedAt' then return nil, 'unavailable' end
    fields = fields + 1
  end
  if fields ~= 4 then return nil, 'unavailable' end
  return p, nil
end
local function get_study(sid)
  if not study_id(sid) or not kind('study:' .. sid, 'string') then return nil, 'unavailable' end
  local raw = redis.call('GET', 'study:' .. sid)
  local indexed = redis.call('SISMEMBER', 'all-studies', sid) == 1
  if not raw then return nil, indexed and 'unavailable' or 'study-not-found' end
  if not indexed then return nil, 'unavailable' end
  local payload = string.sub(raw,1,9) == 'oi:study:' and string.sub(raw,10) or raw
  local ok, s = pcall(cjson.decode,payload)
  if not ok or type(s) ~= 'table' or s.id ~= sid or not integer(s.createdAt) then return nil, 'unavailable' end
  return s, nil
end
local function membership(sid)
  if not kind('study-project:' .. sid, 'string') then return nil, 'unavailable' end
  local pid = redis.call('GET','study-project:' .. sid)
  if not pid then return nil, nil end
  local p, err = get_project(pid)
  if not p then return nil, 'unavailable' end
  return pid, nil
end
local function guard(sid)
  if not kind('study-mutation-guard:' .. sid, 'string') then return result('byos-unavailable') end
  local KEYS = {'study:' .. sid, '', 'study-mutation-guard:' .. sid}
  ${STUDY_DELETION_GUARD_LUA}
  return nil
end
local function guard_error(sid)
  local g = guard(sid)
  if g then return g[1] == 'oi:persist-guard' and 'persist-guard' or 'unavailable' end
  return nil
end
local function array_json(values)
  local out = {}
  for _, v in ipairs(values) do out[#out+1] = cjson.encode(v) end
  return '[' .. table.concat(out, ',') .. ']'
end
-- cjson's 14-significant-digit number encoder cannot preserve every safe integer.
local function project_json(p)
  return '{"id":' .. cjson.encode(p.id) .. ',"name":' .. cjson.encode(p.name)
    .. ',"createdAt":' .. string.format('%.0f',p.createdAt)
    .. ',"updatedAt":' .. string.format('%.0f',p.updatedAt) .. '}'
end
local function json(status, p)
  return {'oi:' .. status, 'oi:json:' .. cjson.encode(p)}
end
if not kind('all-projects','set') or not kind('all-studies','set') then return result('unavailable') end

if op == 'create' then
  if redis.call('SCARD','all-projects') >= 1000 then return result('quota') end
  if not kind('project:' .. id,'string') then return result('unavailable') end
  if redis.call('EXISTS','project:' .. id) == 1 or redis.call('SISMEMBER','all-projects',id) == 1 then return result('conflict') end
  local p = {id=id,name=name,createdAt=now,updatedAt=now}
  redis.call('SET','project:' .. id,'oi:project:' .. project_json(p))
  redis.call('SADD','all-projects',id)
  return {'oi:created','oi:json:' .. project_json(p)}
end

if op == 'assignStudy' then
  local err = guard_error(studyId)
  if err then return result(err) end
  local s; s, err = get_study(studyId)
  if not s then return result(err) end
  local current; current, err = membership(studyId)
  if err then return result(err) end
  if id ~= '' then
    local p; p, err = get_project(id)
    if not p then return result(err) end
  end
  if id == '' then redis.call('DEL','study-project:' .. studyId)
  elseif current ~= id then redis.call('SET','study-project:' .. studyId,id) end
  return json('assigned',{studyId=studyId,projectId=id == '' and cjson.null or id})
end

local p, err
if op ~= 'list' then
  p, err = get_project(id)
  if not p then
    if op == 'delete' and err == 'not-found' then return result('deleted') end
    return result(err)
  end
end
if op == 'rename' then
  if p.name ~= name then
    p.name = name; p.updatedAt = math.max(p.updatedAt,now)
    redis.call('SET','project:' .. id,'oi:project:' .. project_json(p))
  end
  return {'oi:updated','oi:json:' .. project_json(p)}
end
if redis.call('SCARD','all-studies') > 1000 then return result('too-large') end
if op == 'list' and redis.call('SCARD','all-projects') > 1000 then return result('too-large') end
local studies, members, selected = {}, {}, {}
for _, sid in ipairs(redis.call('SMEMBERS','all-studies')) do
  local s; s, err = get_study(sid)
  if not s then return result('unavailable') end
  local pid; pid, err = membership(sid)
  if err then return result(err) end
  studies[#studies+1] = s
  if pid then members[#members+1] = {studyId=sid,projectId=pid} end
  if pid == id then
    if op == 'delete' then
      err = guard_error(sid)
      if err then return result(err) end
    end
    selected[#selected+1] = sid
  end
end
if op == 'delete' then
  for _, sid in ipairs(selected) do redis.call('DEL','study-project:' .. sid) end
  redis.call('DEL','project:' .. id)
  redis.call('SREM','all-projects',id)
  return result('deleted')
end
table.sort(studies,function(a,b) return a.createdAt == b.createdAt and a.id < b.id or a.createdAt > b.createdAt end)
local studyIds = {}
for _, s in ipairs(studies) do
  if op == 'list' then studyIds[#studyIds+1] = s.id
  else
    for _, sid in ipairs(selected) do if sid == s.id then studyIds[#studyIds+1] = sid end end
  end
end
if op == 'read' then return {'oi:found','oi:json:' .. project_json(p),'oi:json:' .. array_json(studyIds)} end
local projects = {}
for _, pid in ipairs(redis.call('SMEMBERS','all-projects')) do
  local item; item, err = get_project(pid)
  if not item then return result('unavailable') end
  projects[#projects+1] = item
end
table.sort(projects,function(a,b) return a.createdAt == b.createdAt and a.id < b.id or a.createdAt > b.createdAt end)
table.sort(members,function(a,b) return a.studyId < b.studyId end)
local encodedProjects = {}
for _, item in ipairs(projects) do encodedProjects[#encodedProjects+1] = project_json(item) end
return {'oi:ok','oi:json:[' .. table.concat(encodedProjects, ',') .. ']','oi:json:' .. array_json(members),'oi:json:' .. array_json(studyIds)}
`;

export function createRedisProjectsStore(client: RedisPort, standaloneOnly: () => void): ProjectsStorePort {
  async function run(method: keyof ProjectsStorePort, input?: { projectId?: string | null; studyId?: string; name?: string }): Promise<ProjectOutcome> {
    standaloneOnly(); // Before validation, UUID allocation, and every Redis command.
    const write = method !== 'list' && method !== 'read';
    const fallback = { status: write ? 'ambiguous' : 'unavailable' } as const;
    if (method !== 'list') {
      const keys = method === 'create' ? ['name'] : method === 'rename' ? ['projectId', 'name']
        : method === 'assignStudy' ? ['studyId', 'projectId'] : ['projectId'];
      if (!closed(input, keys)
        || (method !== 'create' && !(method === 'assignStudy' && input.projectId === null) && !isProjectId(input.projectId))
        || (method === 'assignStudy' && !isStudyId(input.studyId))
        || ((method === 'create' || method === 'rename') && normalizeProjectName(input.name) === null)) return { status: 'unavailable' };
    }
    try {
      const candidateId = method === 'create' ? crypto.randomUUID() : input?.projectId ?? '';
      const value = await client.eval(PROJECTS_SCRIPT, [], [
        method, candidateId,
        normalizeProjectName(input?.name) ?? '', input?.studyId ?? '', String(Date.now()),
      ]);
      if (!Array.isArray(value) || typeof value[0] !== 'string' || !value[0].startsWith('oi:')) return fallback;
      const status = value[0].slice(3);
      const parse = (i: number): unknown => {
        if (typeof value[i] !== 'string' || !value[i].startsWith('oi:json:')) throw new Error('Invalid project reply');
        return JSON.parse(value[i].slice(8));
      };
      let result: unknown;
      if (status === 'ok' && value.length === 4) result = { status, projects: parse(1), memberships: parse(2), studyIds: parse(3) };
      else if (status === 'found' && value.length === 3) result = { status, project: parse(1), studyIds: parse(2) };
      else if ((status === 'created' || status === 'updated') && value.length === 2) result = { status, project: parse(1) };
      else if (status === 'assigned' && value.length === 2) {
        const body = parse(1);
        if (!closed(body, ['studyId', 'projectId'])) return fallback;
        result = { status, ...body };
      } else if (value.length === 1) result = { status };
      if (!isProjectOutcome(result, method, input)) return fallback;
      if (method === 'create' && result.status === 'created' && result.project.id !== candidateId) return fallback;
      return result;
    } catch (error) {
      if (error instanceof RedisCommitAmbiguousError && error.commitState === 'zero-write') return { status: 'unavailable' };
      return fallback;
    }
  }
  return {
    list: () => run('list') as ReturnType<ProjectsStorePort['list']>,
    read: input => run('read', input) as ReturnType<ProjectsStorePort['read']>,
    create: input => run('create', input) as ReturnType<ProjectsStorePort['create']>,
    rename: input => run('rename', input) as ReturnType<ProjectsStorePort['rename']>,
    delete: input => run('delete', input) as ReturnType<ProjectsStorePort['delete']>,
    assignStudy: input => run('assignStudy', input) as ReturnType<ProjectsStorePort['assignStudy']>,
  };
}
