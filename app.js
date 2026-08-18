'use strict';

/* tool-loop-viz — normalise an LLM agent transcript into an ordered, walkable
   step list and render it.

   Constraints that shaped this file:
   - Runs from file://, so: no fetch, no modules, no network of any kind.
   - Input is untrusted. The DOM is built with createElement/textContent only;
     no innerHTML ever touches parsed data.
   - Input may be pathological (megabytes, 200-deep nesting, hostile strings),
     so every traversal is depth-, count- and character-bounded. */

var LIMITS = {
  input: 12e6,     // characters accepted before we refuse outright
  steps: 400,      // steps rendered; any beyond are counted and reported
  depth: 12,       // nesting levels formatted before eliding
  items: 200,      // array items / object keys formatted per level
  value: 100000,   // characters of one formatted value kept in the DOM
  title: 160       // characters of a one-line list title
};

/* ---------------------------------------------------------------- text ---- */

// Control, zero-width and bidi-override characters are escaped rather than
// dropped: left as-is they reorder or hide neighbouring text in the timeline.
var UNSAFE_CHARS = new RegExp('[' +
  '\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F' +
  '\\u200B-\\u200F\\u202A-\\u202E\\u2066-\\u2069\\uFEFF' +
  ']', 'g');

function displayText(value) {
  var s = typeof value === 'string' ? value : String(value);
  return s.replace(UNSAFE_CHARS, function (ch) {
    return '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
  });
}

function firstLine(text, max) {
  var s = displayText(text).replace(/\s+/g, ' ').trim();
  var limit = max || LIMITS.title;
  return s.length > limit ? s.slice(0, limit) + '…' : s;
}

/* Bounded JSON-ish formatter. Not a serialiser: elisions are human notes, so
   the output is for reading, not for round-tripping. */
function writeValue(value, depth, budget) {
  if (budget.left <= 0) return '…';
  var out;
  if (value === null) { out = 'null'; }
  else if (typeof value === 'string') { out = JSON.stringify(value.slice(0, budget.left + 1)); }
  else if (typeof value === 'number' || typeof value === 'boolean') { out = String(value); }
  else if (typeof value !== 'object') { out = String(value); }
  else if (depth >= LIMITS.depth) { out = Array.isArray(value) ? '[ ... ]' : '{ ... }'; }
  else {
    var pad = '  '.repeat(depth + 1);
    var close = '  '.repeat(depth);
    var parts = [];
    var i;
    if (Array.isArray(value)) {
      if (value.length === 0) return take('[]', budget);
      for (i = 0; i < value.length && i < LIMITS.items && budget.left > 0; i++) {
        parts.push(pad + writeValue(value[i], depth + 1, budget));
      }
      if (value.length > LIMITS.items) parts.push(pad + '... ' + (value.length - LIMITS.items) + ' more items');
      return take('[\n' + parts.join(',\n') + '\n' + close + ']', budget);
    }
    var keys = Object.keys(value);
    if (keys.length === 0) return take('{}', budget);
    for (i = 0; i < keys.length && i < LIMITS.items && budget.left > 0; i++) {
      parts.push(pad + JSON.stringify(keys[i]) + ': ' + writeValue(value[keys[i]], depth + 1, budget));
    }
    if (keys.length > LIMITS.items) parts.push(pad + '... ' + (keys.length - LIMITS.items) + ' more keys');
    return take('{\n' + parts.join(',\n') + '\n' + close + '}', budget);
  }
  return take(out, budget);
}

function take(text, budget) {
  budget.left -= text.length;
  return text;
}

// Returns { text, kind }. Strings stay strings: a tool result that is prose
// should read as prose, not as a quoted blob.
function presentValue(value) {
  if (value === undefined) return { text: '', kind: 'text', truncated: false };
  if (typeof value === 'string') {
    var clipped = value.length > LIMITS.value;
    return {
      text: displayText(clipped ? value.slice(0, LIMITS.value) : value),
      kind: 'text',
      truncated: clipped,
      fullLength: value.length
    };
  }
  var budget = { left: LIMITS.value };
  var text = writeValue(value, 0, budget);
  return { text: displayText(text), kind: 'json', truncated: budget.left <= 0 };
}

/* --------------------------------------------------------------- steps ---- */

var KIND_LABEL = {
  user: 'User',
  system: 'System',
  thought: 'Assistant',
  'tool-call': 'Tool call',
  'tool-result': 'Tool result',
  final: 'Final answer',
  note: 'Entry'
};

function makeStep(kind, fields) {
  var step = {
    kind: kind,
    title: '',
    text: undefined,
    toolName: '',
    toolId: '',
    input: undefined,
    result: undefined,
    isError: false,
    timestamp: null,
    pairIndex: -1,
    notes: []
  };
  for (var k in fields) if (Object.prototype.hasOwnProperty.call(fields, k)) step[k] = fields[k];
  return step;
}

function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

// Timestamps are read, never invented: only these fields, only if parseable.
var TIME_KEYS = ['timestamp', 'time', 'ts', 'created_at', 'createdAt', 'started_at'];

function readTimestamp(obj) {
  if (!isPlainObject(obj)) return null;
  for (var i = 0; i < TIME_KEYS.length; i++) {
    var raw = obj[TIME_KEYS[i]];
    if (typeof raw === 'number' && isFinite(raw)) {
      // Heuristic covers the unit only; seconds-since-epoch is common in logs.
      return raw > 1e11 ? raw : raw * 1000;
    }
    if (typeof raw === 'string' && raw) {
      var ms = Date.parse(raw);
      if (!isNaN(ms)) return ms;
    }
  }
  return null;
}

// Anthropic tool_result content is a string, a block array, or anything at all.
function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    var texts = [];
    var onlyText = true;
    for (var i = 0; i < content.length && i < LIMITS.items; i++) {
      var block = content[i];
      if (isPlainObject(block) && typeof block.text === 'string') texts.push(block.text);
      else onlyText = false;
    }
    if (onlyText && texts.length) return texts.join('\n');
    return content;
  }
  return content;
}

function roleKind(role) {
  if (role === 'user' || role === 'human') return 'user';
  if (role === 'system' || role === 'developer') return 'system';
  if (role === 'assistant' || role === 'model') return 'thought';
  return 'note';
}

/* ------------------------------------------------------------ anthropic ---- */

function parseAnthropic(messages) {
  var steps = [];
  for (var i = 0; i < messages.length; i++) {
    var msg = messages[i];
    if (!isPlainObject(msg)) {
      steps.push(makeStep('note', { title: 'Non-object message at index ' + i, result: msg }));
      continue;
    }
    var role = typeof msg.role === 'string' ? msg.role : 'unknown';
    var when = readTimestamp(msg);
    var content = msg.content;

    if (content === undefined || content === null) {
      steps.push(makeStep(roleKind(role), { title: '(no content)', text: '', timestamp: when }));
      continue;
    }
    if (!Array.isArray(content)) {
      // Strings are the common case; numbers and objects are tolerated.
      var asText = typeof content === 'string' ? content : presentValue(content).text;
      steps.push(makeStep(roleKind(role), { title: firstLine(asText) || '(empty)', text: asText, timestamp: when }));
      continue;
    }
    for (var b = 0; b < content.length && b < LIMITS.items; b++) {
      var block = content[b];
      if (typeof block === 'string') {
        steps.push(makeStep(roleKind(role), { title: firstLine(block), text: block, timestamp: when }));
        continue;
      }
      if (!isPlainObject(block)) {
        steps.push(makeStep('note', { title: 'Unrecognised content block', result: block, timestamp: when }));
        continue;
      }
      var type = typeof block.type === 'string' ? block.type : '';
      if (type === 'text' || (!type && typeof block.text === 'string')) {
        var text = typeof block.text === 'string' ? block.text : presentValue(block.text).text;
        steps.push(makeStep(roleKind(role), { title: firstLine(text) || '(empty text block)', text: text, timestamp: when }));
      } else if (type === 'tool_use' || type === 'server_tool_use') {
        steps.push(makeStep('tool-call', {
          toolName: typeof block.name === 'string' ? block.name : '(unnamed tool)',
          toolId: typeof block.id === 'string' ? block.id : '',
          input: block.input,
          timestamp: when
        }));
      } else if (type === 'tool_result' || type === 'web_search_tool_result') {
        steps.push(makeStep('tool-result', {
          toolId: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
          result: flattenContent(block.content),
          isError: block.is_error === true,
          timestamp: when
        }));
      } else if (type === 'thinking') {
        var think = typeof block.thinking === 'string' ? block.thinking : presentValue(block).text;
        steps.push(makeStep('thought', { title: firstLine(think), text: think, timestamp: when, notes: ['extended thinking'] }));
      } else {
        steps.push(makeStep('note', {
          title: type ? 'Block: ' + firstLine(type, 40) : 'Unrecognised block',
          result: block,
          timestamp: when
        }));
      }
    }
  }
  return steps;
}

/* -------------------------------------------------------------- linking ---- */

// Pair calls with results by id, then mark the run's last assistant text as the
// final answer when nothing tool-shaped follows it.
function linkSteps(steps) {
  var byId = Object.create(null);
  var i;
  for (i = 0; i < steps.length; i++) {
    if (steps[i].kind === 'tool-call' && steps[i].toolId && byId[steps[i].toolId] === undefined) {
      byId[steps[i].toolId] = i;
    }
  }
  for (i = 0; i < steps.length; i++) {
    var s = steps[i];
    if (s.kind !== 'tool-result') continue;
    var target = s.toolId ? byId[s.toolId] : undefined;
    if (target !== undefined) {
      s.pairIndex = target;
      steps[target].pairIndex = i;
      if (!s.toolName) s.toolName = steps[target].toolName;
    } else if (s.toolId) {
      s.notes.push('No tool call in this log carries id ' + firstLine(s.toolId, 60));
    } else {
      s.notes.push('This result carries no call id');
    }
  }
  for (i = steps.length - 1; i >= 0; i--) {
    if (steps[i].kind === 'tool-call' || steps[i].kind === 'tool-result') break;
    if (steps[i].kind === 'thought') { steps[i].kind = 'final'; break; }
  }
  for (i = 0; i < steps.length; i++) {
    steps[i].index = i;
    if (!steps[i].title) steps[i].title = defaultTitle(steps[i]);
  }
  return steps;
}

function defaultTitle(step) {
  if (step.kind === 'tool-call') return step.toolName || '(unnamed tool)';
  if (step.kind === 'tool-result') {
    var name = step.toolName ? step.toolName : 'unmatched call';
    return (step.isError ? 'error from ' : 'from ') + name;
  }
  if (step.text !== undefined) return firstLine(step.text) || '(empty)';
  return '(no content)';
}

/* --------------------------------------------------------------- openai ---- */

function parseOpenAI(messages) {
  var steps = [];
  for (var i = 0; i < messages.length; i++) {
    var msg = messages[i];
    if (!isPlainObject(msg)) {
      steps.push(makeStep('note', { title: 'Non-object message at index ' + i, result: msg }));
      continue;
    }
    var role = typeof msg.role === 'string' ? msg.role : 'unknown';
    var when = readTimestamp(msg);
    var text = openAIText(msg.content);

    if (role === 'tool' || role === 'function') {
      steps.push(makeStep('tool-result', {
        toolId: typeof msg.tool_call_id === 'string' ? msg.tool_call_id : '',
        toolName: typeof msg.name === 'string' ? msg.name : '',
        result: maybeJSON(msg.content),
        timestamp: when
      }));
      continue;
    }
    if (text !== '' || (!Array.isArray(msg.tool_calls) && !msg.function_call)) {
      steps.push(makeStep(roleKind(role), { title: firstLine(text) || '(no content)', text: text, timestamp: when }));
    }
    if (Array.isArray(msg.tool_calls)) {
      for (var c = 0; c < msg.tool_calls.length && c < LIMITS.items; c++) {
        steps.push(openAICall(msg.tool_calls[c], when));
      }
    } else if (isPlainObject(msg.function_call)) {
      steps.push(openAICall({ function: msg.function_call }, when));
    }
  }
  return steps;
}

function openAICall(call, when) {
  if (!isPlainObject(call)) return makeStep('note', { title: 'Unrecognised tool call', result: call, timestamp: when });
  var fn = isPlainObject(call.function) ? call.function : call;
  var args = fn.arguments !== undefined ? fn.arguments : fn.args;
  return makeStep('tool-call', {
    toolName: typeof fn.name === 'string' ? fn.name : '(unnamed tool)',
    toolId: typeof call.id === 'string' ? call.id : '',
    // `arguments` is a JSON string in this dialect; keep it raw when it is not
    // parseable rather than hiding what the model actually emitted.
    input: maybeJSON(args),
    timestamp: when
  });
}

// Parses a JSON string when it parses; otherwise hands back the original value.
function maybeJSON(value) {
  if (typeof value !== 'string') return value;
  var trimmed = value.trim();
  if (!trimmed || '{["-0123456789tfn'.indexOf(trimmed.charAt(0)) === -1) return value;
  try { return JSON.parse(trimmed); } catch (err) { return value; }
}

// OpenAI content is a string, null, or an array of typed parts.
function openAIText(content) {
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return '';
  if (Array.isArray(content)) {
    var parts = [];
    for (var i = 0; i < content.length && i < LIMITS.items; i++) {
      var part = content[i];
      if (typeof part === 'string') parts.push(part);
      else if (isPlainObject(part) && typeof part.text === 'string') parts.push(part.text);
      else parts.push(presentValue(part).text);
    }
    return parts.join('\n');
  }
  return presentValue(content).text;
}

/* -------------------------------------------------------------- generic ---- */

var CALL_HINTS = ['tool_use', 'tool_call', 'toolcall', 'function_call', 'action', 'invoke'];
var RESULT_HINTS = ['tool_result', 'tool_response', 'observation', 'result', 'output', 'return'];

// Best effort for logs in no dialect we know: recognise something rather than
// refusing the file.
function parseGeneric(entries) {
  var steps = [];
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    if (typeof entry === 'string') {
      steps.push(makeStep('note', { title: firstLine(entry) || '(empty)', text: entry }));
      continue;
    }
    if (!isPlainObject(entry)) {
      steps.push(makeStep('note', { title: describeType(entry) + ' at index ' + i, result: entry }));
      continue;
    }
    var when = readTimestamp(entry);
    var tag = String(entry.type || entry.kind || entry.event || entry.role || '').toLowerCase();
    var name = pickString(entry, ['name', 'tool', 'tool_name', 'toolName', 'function', 'action']);
    var input = pickValue(entry, ['input', 'arguments', 'args', 'parameters', 'params', 'tool_input']);
    var output = pickValue(entry, ['result', 'output', 'observation', 'response', 'content', 'text', 'message']);
    var id = pickString(entry, ['tool_use_id', 'tool_call_id', 'call_id', 'id']);

    if (matchesAny(tag, CALL_HINTS) || (input !== undefined && output === undefined && name)) {
      steps.push(makeStep('tool-call', { toolName: name || '(unnamed tool)', toolId: id, input: input, timestamp: when }));
    } else if (matchesAny(tag, RESULT_HINTS) || (output !== undefined && name && input === undefined)) {
      steps.push(makeStep('tool-result', {
        toolName: name, toolId: id, result: maybeJSON(output),
        isError: entry.is_error === true || entry.error === true || entry.status === 'error',
        timestamp: when
      }));
    } else {
      var kind = roleKind(tag);
      if (kind === 'note' && matchesAny(tag, ['thought', 'text', 'message', 'answer', 'reason'])) kind = 'thought';
      var text = typeof output === 'string' ? output : (output === undefined ? '' : presentValue(output).text);
      steps.push(makeStep(kind, {
        title: text ? firstLine(text) : (tag ? firstLine(tag, 60) : 'Entry ' + i),
        text: text,
        result: text ? undefined : entry,
        timestamp: when
      }));
    }
  }
  return steps;
}

function matchesAny(tag, hints) {
  for (var i = 0; i < hints.length; i++) if (tag.indexOf(hints[i]) !== -1) return true;
  return false;
}

function pickString(obj, keys) {
  for (var i = 0; i < keys.length; i++) {
    var v = obj[keys[i]];
    if (typeof v === 'string' && v) return v;
    if (isPlainObject(v) && typeof v.name === 'string') return v.name;
  }
  return '';
}

function pickValue(obj, keys) {
  for (var i = 0; i < keys.length; i++) if (obj[keys[i]] !== undefined) return obj[keys[i]];
  return undefined;
}

/* ------------------------------------------------------------- dialects ---- */

var DIALECTS = {
  anthropic: { label: 'Anthropic messages', parse: parseAnthropic },
  openai: { label: 'OpenAI chat', parse: parseOpenAI },
  generic: { label: 'generic step list', parse: parseGeneric }
};

function detectDialect(messages) {
  var sawRole = false;
  for (var i = 0; i < messages.length && i < 500; i++) {
    var m = messages[i];
    if (!isPlainObject(m)) continue;
    if (Array.isArray(m.tool_calls) || m.function_call !== undefined ||
        m.role === 'tool' || typeof m.tool_call_id === 'string') return 'openai';
    if (typeof m.role === 'string') sawRole = true;
    if (Array.isArray(m.content)) {
      for (var b = 0; b < m.content.length && b < 20; b++) {
        var block = m.content[b];
        if (isPlainObject(block) && (block.type === 'tool_use' || block.type === 'tool_result')) return 'anthropic';
      }
    }
  }
  return sawRole ? 'anthropic' : 'generic';
}

/* ---------------------------------------------------------------- entry ---- */

function ParseError(message) { this.name = 'ParseError'; this.message = message; }
ParseError.prototype = Object.create(Error.prototype);

var CONTAINER_KEYS = ['messages', 'steps', 'events', 'trace', 'transcript', 'conversation', 'history', 'turns', 'items', 'log'];

function parseTranscript(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') throw new ParseError('Nothing to parse - the input is empty.');
  if (raw.length > LIMITS.input) {
    throw new ParseError('Input is ' + raw.length.toLocaleString() + ' characters; this page parses up to ' + LIMITS.input.toLocaleString() + '.');
  }
  var data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new ParseError('That is not valid JSON: ' + firstLine(err && err.message ? err.message : String(err), 200));
  }
  var messages = asMessageList(data);
  var dialect = detectDialect(messages);
  var steps = linkSteps(DIALECTS[dialect].parse(messages));
  if (steps.length === 0) throw new ParseError('Parsed as JSON, but no steps were found in it.');
  return { steps: steps, dialect: DIALECTS[dialect].label };
}

function asMessageList(data) {
  if (Array.isArray(data)) return data;
  if (isPlainObject(data)) {
    for (var i = 0; i < CONTAINER_KEYS.length; i++) {
      if (Array.isArray(data[CONTAINER_KEYS[i]])) return data[CONTAINER_KEYS[i]];
    }
    if (typeof data.role === 'string' || data.content !== undefined) return [data];
    throw new ParseError('Expected an array of messages, or an object with a "messages" array. This object has keys: ' +
      firstLine(Object.keys(data).slice(0, 8).join(', ') || '(none)', 120) + '.');
  }
  throw new ParseError('Expected an array of messages; got ' + describeType(data) + '.');
}

function describeType(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  if (typeof v === 'string') return 'a string';
  return 'a ' + typeof v;
}
