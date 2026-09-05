/**
 * Redis cjson loses empty-array types when it decodes JSON into Lua tables.
 * Study mutations therefore replace only named object members and retain every
 * other JSON value verbatim. Callers validate the complete JSON with cjson first;
 * this scanner only locates member boundaries, including nested/escaped content.
 * It uses standard Redis Lua features, without version-specific cjson settings.
 */
export const STUDY_JSON_LUA = `
local function json_string_end(raw, pos)
  pos = pos + 1
  while pos <= #raw do
    local byte = string.byte(raw, pos)
    if byte == 34 then return pos + 1 end
    if byte == 92 then pos = pos + 2 else pos = pos + 1 end
  end
  error('Unterminated JSON string')
end

local function json_object_members(raw)
  local _, opening = string.find(raw, '^%s*{')
  if not opening then error('Expected JSON object') end
  local members = {}
  local pos = opening + 1
  while pos <= #raw do
    while string.match(string.sub(raw, pos, pos), '%s') do pos = pos + 1 end
    if string.byte(raw, pos) == 125 then return members end
    local keyStart = pos
    pos = json_string_end(raw, pos)
    local rawKey = string.sub(raw, keyStart, pos - 1)
    while string.match(string.sub(raw, pos, pos), '%s') do pos = pos + 1 end
    pos = pos + 1 -- colon, already checked by cjson.decode
    local valueStart = pos
    local depth = 0
    while pos <= #raw do
      local byte = string.byte(raw, pos)
      if byte == 34 then
        pos = json_string_end(raw, pos)
      elseif depth == 0 and (byte == 44 or byte == 125) then
        break
      else
        if byte == 91 or byte == 123 then depth = depth + 1 end
        if byte == 93 or byte == 125 then depth = depth - 1 end
        pos = pos + 1
      end
    end
    members[#members + 1] = {
      key = cjson.decode(rawKey),
      rawKey = rawKey,
      value = string.sub(raw, valueStart, pos - 1)
    }
    if string.byte(raw, pos) == 125 then return members end
    pos = pos + 1 -- comma, already checked by cjson.decode
  end
  error('Unterminated JSON object')
end

local function json_object_value(raw, key)
  local found = nil
  for _, member in ipairs(json_object_members(raw)) do
    if member.key == key then found = member.value end
  end
  return found
end

local function patch_json_object(raw, updates)
  local replacements = {}
  for _, update in ipairs(updates) do replacements[update[1]] = update[2] end
  local parts = {}
  local seen = {}
  for _, member in ipairs(json_object_members(raw)) do
    parts[#parts + 1] = member.rawKey .. ':' .. (replacements[member.key] or member.value)
    seen[member.key] = true
  end
  for _, update in ipairs(updates) do
    if not seen[update[1]] then
      parts[#parts + 1] = cjson.encode(update[1]) .. ':' .. update[2]
    end
  end
  return '{' .. table.concat(parts, ',') .. '}'
end

local function encode_study(payload, prefixed)
  if prefixed then return 'oi:study:' .. payload end
  return payload
end
`;
