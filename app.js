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
  var list = asMessageList(data);
  var steps = linkSteps(parseAnthropic(list.messages));
  if (steps.length === 0) throw new ParseError('Parsed as JSON, but no steps were found in it.');
  return { steps: steps, dialect: list.dialect };
}

function asMessageList(data) {
  if (Array.isArray(data)) return { messages: data, dialect: 'Anthropic messages' };
  if (isPlainObject(data)) {
    for (var i = 0; i < CONTAINER_KEYS.length; i++) {
      if (Array.isArray(data[CONTAINER_KEYS[i]])) return { messages: data[CONTAINER_KEYS[i]], dialect: 'Anthropic messages' };
    }
    if (typeof data.role === 'string' || data.content !== undefined) {
      return { messages: [data], dialect: 'Anthropic messages' };
    }
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
