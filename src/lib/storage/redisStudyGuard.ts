// Deletion/mutation guard only. Project membership must not inspect study-persisting.
export const STUDY_DELETION_GUARD_LUA = `
local mutationRaw = redis.call('GET', KEYS[3])
if mutationRaw then
  if type(mutationRaw) ~= 'string' or string.sub(mutationRaw, 1, 7) ~= 'oi:smg:' then
    return {'oi:byos-unavailable'}
  end
  local mok, mutation = pcall(cjson.decode, string.sub(mutationRaw, 8))
  if not mok or type(mutation) ~= 'table' then
    return {'oi:byos-unavailable'}
  end
  if mutation.state ~= 'created' then
    return {'oi:persist-guard'}
  end
end
`;
