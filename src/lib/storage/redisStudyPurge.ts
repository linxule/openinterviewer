/** Each atomic pass deletes at most 100 members per study-owned index. */
export const STUDY_PURGE_BATCH = 100;

export const STUDY_AUXILIARY_PURGE_LUA = `
local function valid_auxiliary_types(studyId, mode)
  local function expected(key, kind)
    local actual = redis.call('TYPE', key).ok
    return actual == 'none' or actual == kind
  end
  if not expected('study-consent-index:' .. studyId, 'set')
    or not expected('study-exploration-index:' .. studyId, 'set')
    or not expected('study-exploration-keys:' .. studyId, 'hash')
    or not expected('study-exploration-order:' .. studyId, 'zset')
    or not expected('study-interviews:' .. studyId, 'set')
    or not expected('study-persisting:' .. studyId, 'set') then return false end
  if mode == 'standalone' then
    if not expected('create-idemp-index:standalone', 'zset')
      or not expected('study-link-index:' .. studyId, 'set')
      or not expected('participant-link-index:none', 'set')
      or not expected('all-interviews', 'set') or not expected('all-studies', 'set') then return false end
    if redis.call('ZCARD', 'create-idemp-index:standalone') > 100
      or redis.call('SCARD', 'participant-link-index:none') > 1000 then return false end
  end
  return true
end
local function purge_auxiliary(studyId, mode)
  local remaining = false
  local function batch(index, remove)
    local ids = redis.call('SRANDMEMBER', index, 100)
    for _, id in ipairs(ids) do remove(id); redis.call('SREM', index, id) end
    if redis.call('SCARD', index) > 0 then remaining = true else redis.call('DEL', index) end
  end
  batch('study-consent-index:' .. studyId, function(key)
    if string.match(key, '^participant%-consent:%x+$') then
      local raw = redis.call('GET', key)
      local ok, consent = pcall(cjson.decode, raw or '')
      if ok and type(consent) == 'table' and consent.studyId == studyId then redis.call('DEL', key) end
    end
  end)
  batch('study-exploration-index:' .. studyId, function(id)
    redis.call('DEL', 'study-exploration:' .. studyId .. ':' .. id)
    redis.call('ZREM', 'study-exploration-order:' .. studyId, id)
  end)
  if redis.call('SCARD', 'study-exploration-index:' .. studyId) == 0 then
    redis.call('DEL', 'study-exploration-keys:' .. studyId, 'study-exploration-order:' .. studyId)
  end
  if mode == 'standalone' then
    -- Create replay receipts can contain the original collection protocol.
    -- Retain consumed-key authority, never the deleted research configuration.
    local createIndex = 'create-idemp-index:standalone'
    for _, digest in ipairs(redis.call('ZRANGE', createIndex, 0, -1)) do
      local key = 'create-idemp:' .. digest
      local raw = redis.call('GET', key)
      if raw and string.sub(raw, 1, 9) == 'oi:idemp:' then
        local ok, mapping = pcall(cjson.decode, string.sub(raw, 10))
        if ok and type(mapping) == 'table' and mapping.studyId == studyId then
          local tombstone = {version=mapping.version, researcherId=mapping.researcherId,
            studyId=mapping.studyId, createdAt=mapping.createdAt, updatedAt=mapping.updatedAt,
            fingerprint=mapping.fingerprint, state='deleted', operationId=mapping.operationId or cjson.null,
            study=cjson.null}
          redis.call('SET', key, 'oi:idemp:' .. cjson.encode(tombstone), 'KEEPTTL')
        end
      elseif not raw then redis.call('ZREM', createIndex, digest) end
    end
    batch('study-link-index:' .. studyId, function(id)
      local raw = redis.call('GET', 'participant-link:' .. id)
      local payload = raw and (string.sub(raw, 1, 8) == 'oi:link:' and string.sub(raw, 9) or raw) or ''
      local ok, link = pcall(cjson.decode, payload)
      if ok and type(link) == 'table' and link.studyId == studyId then
        redis.call('DEL', 'participant-link:' .. id)
        redis.call('SREM', 'participant-link-index:none', id)
      end
    end)
    -- Legacy standalone links have only the global lifetime-bounded index
    -- (maximum 1000). No KEYS/SCAN of unrelated tenant data is performed.
    local legacyIndex = 'participant-link-index:none'
    if redis.call('SCARD', legacyIndex) > 1000 then return false end
    local deleted = 0
    for _, id in ipairs(redis.call('SMEMBERS', legacyIndex)) do
      local raw = redis.call('GET', 'participant-link:' .. id)
      if raw then
        local payload = string.sub(raw, 1, 8) == 'oi:link:' and string.sub(raw, 9) or raw
        local ok, link = pcall(cjson.decode, payload)
        if ok and type(link) == 'table' and link.studyId == studyId then
          if deleted < 100 then
            redis.call('DEL', 'participant-link:' .. id)
            redis.call('SREM', legacyIndex, id)
            deleted = deleted + 1
          else remaining = true end
        end
      else redis.call('SREM', legacyIndex, id) end
    end
  end
  return not remaining
end
`;

/** A tombstone fences completion/config/analysis before bounded data removal. */
export const DELETE_POPULATED_STUDY_SCRIPT = `${STUDY_AUXILIARY_PURGE_LUA}
local mode = ARGV[6]
if mode ~= 'hosted' and mode ~= 'standalone' then return {'oi:byos-unavailable'} end
if #KEYS ~= (mode == 'hosted' and 6 or 7) then return {'oi:byos-unavailable'} end
local receiptKey = KEYS[mode == 'hosted' and 3 or 4]
local guardKey = KEYS[mode == 'hosted' and 4 or 5]
local persistSet = KEYS[mode == 'hosted' and 5 or 6]
local aggregateKey = KEYS[mode == 'hosted' and 6 or 7]
local function decode(raw, prefix)
  if type(raw) ~= 'string' or string.sub(raw, 1, #prefix) ~= prefix then return nil end
  local ok, obj = pcall(cjson.decode, string.sub(raw, #prefix + 1))
  return ok and type(obj) == 'table' and obj or nil
end
local receiptRaw = redis.call('GET', receiptKey)
if receiptRaw then
  local receipt = decode(receiptRaw, 'oi:receipt:')
  if not receipt or receipt.studyId ~= ARGV[1] or receipt.markerId ~= ARGV[2] then return {'oi:byos-unavailable'} end
  if receipt.resolution == 'deleted' then return {'oi:deleted'} end
  if receipt.resolution == 'cancelled' then return {'oi:cancelled'} end
end
local guardRaw = redis.call('GET', guardKey)
local guard = guardRaw and decode(guardRaw, 'oi:smg:') or nil
if guardRaw and not guard then return {'oi:byos-unavailable'} end
local resuming = guard and guard.kind == 'delete' and guard.state == 'in-flight'
  and guard.markerId == ARGV[2] and guard.deleteInterviews == true
local sameDelete = guard and guard.kind == 'delete' and guard.state == 'in-flight' and guard.markerId == ARGV[2]
if guard and guard.state ~= 'created' and not sameDelete then return {'oi:still-pending'} end
-- A live completion must finish/recover first. Refusal has no new side effects.
if redis.call('SCARD', persistSet) > 0 then return {'oi:still-pending'} end
if not valid_auxiliary_types(ARGV[1], mode) then return {'oi:byos-unavailable'} end
local ids = redis.call('SRANDMEMBER', KEYS[2], 100)
-- Refuse a corrupt cross-study index before any write, never delete a foreign
-- study's primary record because a stale index claimed it.
for _, id in ipairs(ids) do
  local raw = redis.call('GET', 'interview:' .. id)
  if raw then
    local payload = string.sub(raw, 1, 13) == 'oi:interview:' and string.sub(raw, 14) or raw
    local ok, interview = pcall(cjson.decode, payload)
    if not ok or type(interview) ~= 'table' or interview.id ~= id or interview.studyId ~= ARGV[1] then
      return {'oi:byos-unavailable'}
    end
  end
end
if not resuming then
  local studyRaw = redis.call('GET', KEYS[1])
  if studyRaw then
    local payload = string.sub(studyRaw, 1, 9) == 'oi:study:' and string.sub(studyRaw, 10) or studyRaw
    local ok, study = pcall(cjson.decode, payload)
    if not ok or type(study) ~= 'table' or study.id ~= ARGV[1] then return {'oi:byos-unavailable'} end
    if ARGV[7] ~= '' and (tonumber(study.revision) or 1) ~= tonumber(ARGV[7]) then
      return {'oi:conflict', 'oi:revision:' .. string.format('%.0f', tonumber(study.revision) or 1)}
    end
  end
  redis.call('SET', guardKey, ARGV[4])
end
-- The study remains visible but all writers are fenced until final removal.
for _, id in ipairs(ids) do
  redis.call('DEL', 'interview:' .. id, 'interview-fingerprint:' .. id, 'interview-persisting:' .. id)
  redis.call('SREM', KEYS[2], id)
  if mode == 'standalone' then redis.call('SREM', 'all-interviews', id) end
end
redis.call('DEL', aggregateKey)
local auxiliaryDone = purge_auxiliary(ARGV[1], mode)
if redis.call('SCARD', KEYS[2]) > 0 or not auxiliaryDone then return {'oi:still-pending'} end
redis.call('DEL', KEYS[1], KEYS[2], persistSet)
if mode == 'standalone' then redis.call('SREM', KEYS[3], ARGV[1]) end
redis.call('SET', receiptKey, ARGV[3], 'EX', 604800)
redis.call('DEL', guardKey)
return {'oi:deleted'}
`;
