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
          result: maybeJSON(flattenContent(block.content)),
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

/* ------------------------------------------------------------ rendering ---- */

/* Everything below builds DOM nodes by hand. Transcript text reaches the page
   only through textContent, so hostile markup in a log is inert. */

var state = { steps: [], selected: 0, rendered: 0, dialect: '' };

var els = {
  input: document.getElementById('input'),
  status: document.getElementById('status'),
  summary: document.getElementById('summary'),
  timeline: document.getElementById('timeline'),
  timelineNote: document.getElementById('timeline-note'),
  detail: document.getElementById('detail'),
  dropVeil: document.getElementById('drop-veil')
};

function el(tag, className, text) {
  var node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

function setStatus(message, isError) {
  els.status.textContent = message;
  els.status.classList.toggle('error', !!isError);
}

function formatTime(ms) {
  var d = new Date(ms);
  return isNaN(d.getTime()) ? '' : d.toISOString().slice(11, 19) + 'Z';
}

function formatDuration(ms) {
  if (ms < 1000) return ms + ' ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + ' s';
  var mins = Math.floor(ms / 60000);
  return mins + ' m ' + Math.round((ms % 60000) / 1000) + ' s';
}

/* Renders a value into a slot. Clamping is added in a later pass, once the slot
   is in the document and its real height is known. */
function appendValue(parent, value, emptyLabel) {
  var shown = presentValue(value);
  if (shown.text === '') {
    parent.appendChild(el('p', 'value empty', emptyLabel || '(empty)'));
    return;
  }
  var slot = el('div', 'value-slot');
  var body = el('div', 'value-body');
  body.appendChild(el('pre', 'value', shown.text));
  slot.appendChild(body);
  slot.appendChild(el('div', 'value-fade'));
  if (shown.truncated) {
    var note = 'Value clipped at ' + LIMITS.value.toLocaleString() + ' characters';
    if (shown.fullLength) note += ' of ' + shown.fullLength.toLocaleString();
    slot.appendChild(el('p', 'note', note + '.'));
  }
  parent.appendChild(slot);
}

function renderTimeline() {
  clear(els.timeline);
  var limit = Math.min(state.steps.length, LIMITS.steps);
  state.rendered = limit;
  for (var i = 0; i < limit; i++) {
    els.timeline.appendChild(buildOption(state.steps[i]));
  }
  if (state.steps.length > limit) {
    els.timelineNote.textContent = 'Showing the first ' + limit + ' steps; ' +
      (state.steps.length - limit) + ' further steps were parsed but are not listed.';
    els.timelineNote.hidden = false;
  } else {
    els.timelineNote.textContent = '';
    els.timelineNote.hidden = true;
  }
}

function buildOption(step) {
  var li = el('li', 'step kind-' + step.kind + (step.isError ? ' is-error' : ''));
  li.id = 'step-' + step.index;
  li.setAttribute('role', 'option');
  li.setAttribute('aria-selected', 'false');
  li.tabIndex = -1;

  var head = el('div', 'step-head');
  head.appendChild(el('span', 'step-index', String(step.index + 1)));
  head.appendChild(el('span', 'step-kind', KIND_LABEL[step.kind] || 'Step'));
  li.appendChild(head);
  li.appendChild(el('span', 'step-title', step.title));

  li.addEventListener('click', function () { select(step.index, true); });
  return li;
}

function renderDetail() {
  clear(els.detail);
  var step = state.steps[state.selected];
  if (!step) {
    els.detail.appendChild(el('p', 'empty', 'No step selected.'));
    return;
  }
  els.detail.appendChild(el('p', 'detail-kind', KIND_LABEL[step.kind] || 'Step'));
  // Text steps carry their content in the Text section below; repeating it as a
  // heading would just say the same thing twice.
  var heading = step.toolName || (step.text === undefined ? step.title : '');
  if (heading) els.detail.appendChild(el('p', 'detail-title', displayText(heading)));

  var meta = ['Step ' + (step.index + 1) + ' of ' + state.steps.length];
  if (step.toolId) meta.push('id ' + firstLine(step.toolId, 60));
  if (step.timestamp !== null) meta.push(formatTime(step.timestamp));
  els.detail.appendChild(el('p', 'detail-meta', meta.join('  ·  ')));

  if (step.isError) els.detail.appendChild(el('span', 'error-flag', 'error result'));

  if (step.kind === 'tool-call') {
    section('Input', function (body) { appendValue(body, step.input, '(no input)'); });
  }
  if (step.kind === 'tool-result') {
    section('Result', function (body) { appendValue(body, step.result, '(empty result)'); });
  }
  if (step.text !== undefined) {
    section('Text', function (body) { appendValue(body, step.text, '(no text)'); });
  }
  if (step.kind === 'note' && step.result !== undefined) {
    section('Raw entry', function (body) { appendValue(body, step.result); });
  }

  if (step.pairIndex >= 0) {
    var other = state.steps[step.pairIndex];
    section(step.kind === 'tool-call' ? 'Result' : 'Call', function (body) {
      var link = el('button', 'link', (step.kind === 'tool-call' ? 'Go to result at step ' : 'Go to call at step ') + (other.index + 1));
      link.type = 'button';
      link.addEventListener('click', function () { select(other.index, true); });
      body.appendChild(link);
    });
  } else if (step.kind === 'tool-call') {
    section('Result', function (body) { body.appendChild(el('p', 'note', 'No result for this call appears in the log.')); });
  }

  if (step.notes.length) {
    section('Notes', function (body) {
      for (var i = 0; i < step.notes.length; i++) body.appendChild(el('p', 'note', step.notes[i]));
    });
  }

  function section(title, build) {
    var wrap = el('section', 'detail-section');
    wrap.appendChild(el('h3', null, title));
    build(wrap);
    els.detail.appendChild(wrap);
  }

  // Measured last, when the slots are in the document at their real width.
  clampSlots();
}

function select(index, moveFocus) {
  if (!state.steps.length) return;
  // Selection is bounded by what is actually listed: beyond LIMITS.steps there
  // is no option to focus.
  var last = Math.max(0, Math.min(state.rendered, state.steps.length) - 1);
  var next = Math.max(0, Math.min(index, last));
  state.selected = next;
  var options = els.timeline.children;
  for (var i = 0; i < options.length; i++) {
    var isSelected = i === next;
    options[i].setAttribute('aria-selected', isSelected ? 'true' : 'false');
    options[i].tabIndex = isSelected ? 0 : -1;
  }
  var current = options[next];
  if (current) {
    current.scrollIntoView({ block: 'nearest' });
    if (moveFocus) current.focus();
  }
  renderDetail();
}

function showRun(result, note) {
  state.steps = result.steps;
  state.dialect = result.dialect;
  state.selected = 0;
  renderTimeline();
  renderSummary();
  select(0, false);
  setStatus(note || (result.steps.length + ' steps from a ' + result.dialect + ' transcript.'), false);
}

// A failed parse must never wipe a run that is already on screen.
function loadText(raw, label) {
  try {
    var result = parseTranscript(raw);
    showRun(result, (label ? label + ': ' : '') + result.steps.length + ' steps, read as ' + result.dialect + '.');
  } catch (err) {
    var message = err && err.message ? err.message : String(err);
    setStatus(message + (state.steps.length ? ' The run already on screen is unchanged.' : ''), true);
  }
}

/* ----------------------------------------------------------------- boot ---- */

document.getElementById('render-btn').addEventListener('click', function () {
  loadText(els.input.value, 'Pasted');
});

els.input.addEventListener('keydown', function (event) {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    loadText(els.input.value, 'Pasted');
  }
});

/* Listbox keys. Selection follows focus, which is the pattern a single-select
   listbox is expected to use. */
els.timeline.addEventListener('keydown', function (event) {
  var next;
  switch (event.key) {
    case 'ArrowDown': case 'ArrowRight': next = state.selected + 1; break;
    case 'ArrowUp': case 'ArrowLeft': next = state.selected - 1; break;
    case 'PageDown': next = state.selected + 10; break;
    case 'PageUp': next = state.selected - 10; break;
    case 'Home': next = 0; break;
    case 'End': next = state.rendered - 1; break;
    default: return;
  }
  event.preventDefault();
  select(next, true);
});

// Tabbing to the list lands on the selected option, not the container.
els.timeline.addEventListener('focus', function () {
  var current = els.timeline.children[state.selected];
  if (current) current.focus();
});

/* -------------------------------------------------------------- clamping ---- */

/* The clamp bounds the idle height of a value slot and nothing else. It is
   applied only after measuring, and only together with a control that removes
   it, so no content can end up clipped with no way to reveal it. That failure
   showed up at narrow widths in an earlier build, which is why the decision is
   made from measured height rather than from a width breakpoint, and re-made
   whenever the viewport changes. */
var CLAMP_SLACK_PX = 24;

function clampLimitPx() {
  var rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  return rem * 12;
}

function clampSlots() {
  var slots = els.detail.querySelectorAll('.value-slot');
  var limit = clampLimitPx();
  for (var i = 0; i < slots.length; i++) {
    var slot = slots[i];
    var body = slot.querySelector('.value-body');
    var toggle = slot.querySelector('.value-toggle');
    if (slot.dataset.expanded === 'true') continue;   // user opened it; leave it open
    slot.classList.remove('clamped');
    var overflows = body.scrollHeight > limit + CLAMP_SLACK_PX;
    if (overflows) {
      if (!toggle) toggle = addToggle(slot);
      toggle.hidden = false;
      slot.classList.add('clamped');
    } else if (toggle) {
      toggle.hidden = true;
    }
  }
}

function addToggle(slot) {
  var toggle = el('button', 'link value-toggle', 'Show the whole value');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.addEventListener('click', function () {
    var open = slot.dataset.expanded === 'true';
    slot.dataset.expanded = open ? 'false' : 'true';
    slot.classList.toggle('clamped', open);
    toggle.setAttribute('aria-expanded', open ? 'false' : 'true');
    toggle.textContent = open ? 'Show the whole value' : 'Show less';
  });
  slot.appendChild(toggle);
  return toggle;
}

var resizeTimer = null;
window.addEventListener('resize', function () {
  if (resizeTimer !== null) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(function () { resizeTimer = null; clampSlots(); }, 120);
});

/* --------------------------------------------------------------- summary ---- */

function summarise(steps) {
  var tools = [];
  var calls = 0, errors = 0, first = null, last = null;
  for (var i = 0; i < steps.length; i++) {
    var step = steps[i];
    if (step.kind === 'tool-call') {
      calls++;
      if (step.toolName && tools.indexOf(step.toolName) === -1 && tools.length < 40) tools.push(step.toolName);
    }
    if (step.isError) errors++;
    if (step.timestamp !== null) {
      if (first === null || step.timestamp < first) first = step.timestamp;
      if (last === null || step.timestamp > last) last = step.timestamp;
    }
  }
  return {
    steps: steps.length,
    calls: calls,
    errors: errors,
    tools: tools,
    // Elapsed is reported only when the log itself carries usable timestamps.
    elapsed: (first !== null && last !== null && last > first) ? last - first : null
  };
}

function renderSummary() {
  clear(els.summary);
  if (!state.steps.length) return;
  var s = summarise(state.steps);
  metric('Steps', String(s.steps));
  metric('Tool calls', String(s.calls));
  metric('Errors', String(s.errors));
  metric('Distinct tools', String(s.tools.length));
  if (s.tools.length) metric('Tools used', firstLine(s.tools.join(', '), 90));
  if (s.elapsed !== null) metric('Elapsed', formatDuration(s.elapsed));
  metric('Format', state.dialect);

  function metric(label, value) {
    var wrap = el('div', 'metric');
    wrap.appendChild(el('span', 'metric-label', label));
    wrap.appendChild(el('span', 'metric-value', value));
    els.summary.appendChild(wrap);
  }
}

/* ---------------------------------------------------------- file dropping ---- */

var dragDepth = 0;

function showVeil(show) {
  els.dropVeil.hidden = !show;
}

window.addEventListener('dragenter', function (event) {
  event.preventDefault();
  dragDepth++;
  showVeil(true);
});

window.addEventListener('dragover', function (event) { event.preventDefault(); });

window.addEventListener('dragleave', function () {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) showVeil(false);
});

window.addEventListener('drop', function (event) {
  event.preventDefault();
  dragDepth = 0;
  showVeil(false);
  var files = event.dataTransfer && event.dataTransfer.files;
  if (!files || !files.length) {
    var text = event.dataTransfer && event.dataTransfer.getData('text');
    if (text) { els.input.value = text; loadText(text, 'Dropped text'); }
    return;
  }
  var file = files[0];
  var reader = new FileReader();
  reader.onerror = function () { setStatus('Could not read ' + firstLine(file.name, 60) + '.', true); };
  reader.onload = function () {
    var raw = typeof reader.result === 'string' ? reader.result : '';
    els.input.value = raw.length > LIMITS.input ? '' : raw;
    loadText(raw, firstLine(file.name, 60));
  };
  reader.readAsText(file);
});

/* --------------------------------------------------------------- example ---- */

/* A hand-written transcript in Anthropic Messages format, kept inline so the
   page works when opened directly from disk (fetch is blocked on file://).
   It exercises the shapes the viewer has to handle: several tool calls, a
   failing result, a long result worth clamping, and per-message timestamps. */
var EXAMPLE_TRANSCRIPT = [
  {
    "role": "user",
    "timestamp": "2026-08-17T02:14:03Z",
    "content": "The nightly orders_export job reported success but wrote about 40 percent fewer rows than Sunday. Work out what changed."
  },
  {
    "role": "assistant",
    "timestamp": "2026-08-17T02:14:07Z",
    "content": [
      { "type": "text", "text": "I will start from the run history to see when the drop began, then read the log for the first bad run." },
      { "type": "tool_use", "id": "toolu_01aRun", "name": "list_job_runs", "input": { "job": "orders_export", "limit": 5 } }
    ]
  },
  {
    "role": "user",
    "timestamp": "2026-08-17T02:14:09Z",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "toolu_01aRun",
        "content": "[{\"run_id\":\"2026-08-17T02:00Z\",\"status\":\"success\",\"rows\":184220,\"duration_s\":412},{\"run_id\":\"2026-08-16T02:00Z\",\"status\":\"success\",\"rows\":183914,\"duration_s\":408},{\"run_id\":\"2026-08-15T02:00Z\",\"status\":\"success\",\"rows\":306771,\"duration_s\":655},{\"run_id\":\"2026-08-14T02:00Z\",\"status\":\"success\",\"rows\":305902,\"duration_s\":651},{\"run_id\":\"2026-08-13T02:00Z\",\"status\":\"success\",\"rows\":304118,\"duration_s\":649}]"
      }
    ]
  },
  {
    "role": "assistant",
    "timestamp": "2026-08-17T02:14:15Z",
    "content": [
      { "type": "text", "text": "The drop starts with the run on 16 August, and duration fell with it, so rows are being excluded rather than lost late in the write. Reading that run log." },
      { "type": "tool_use", "id": "toolu_02bLog", "name": "fetch_run_log", "input": { "run_id": "2026-08-16T02:00Z", "tail_lines": 40 } }
    ]
  },
  {
    "role": "user",
    "timestamp": "2026-08-17T02:14:18Z",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "toolu_02bLog",
        "content": "02:00:01 INFO  orders_export starting, config revision 8f21c04\n02:00:01 INFO  source: warehouse.orders (partitioned by order_date)\n02:00:02 INFO  applying filter set: default_filters, region_filters, status_filters\n02:00:02 WARN  status_filters changed since last run (checksum 41ba -> 9d07)\n02:00:03 INFO  planning scan over 41 partitions\n02:00:44 INFO  scanned 41 partitions, 306,880 candidate rows\n02:00:44 INFO  filter default_filters removed 109 rows\n02:00:45 INFO  filter region_filters removed 0 rows\n02:01:02 INFO  filter status_filters removed 122,551 rows\n02:01:02 INFO  122,551 rows removed by predicate status IN ('complete')\n02:01:03 INFO  183,914 rows survive filtering\n02:01:03 INFO  writing to s3://exports/orders/2026-08-16/\n02:03:51 INFO  wrote part-00000 of 18\n02:04:33 INFO  wrote part-00017 of 18\n02:06:44 INFO  checksum manifest written\n02:06:48 INFO  downstream notification sent to analytics-etl\n02:06:48 INFO  orders_export finished status=success rows=183914 duration_s=408\n02:06:48 DEBUG memory high-water 2.1 GiB, spill events 0\n02:06:48 DEBUG partition skew ratio 1.12\n02:06:49 DEBUG filter timings: default 0.4s, region 0.2s, status 17.1s\n02:06:49 DEBUG status filter predicate compiled from config key export.status_allowlist\n02:06:49 DEBUG export.status_allowlist resolved to ['complete']\n02:06:49 DEBUG previous resolved value on 2026-08-15 was ['complete','shipped','partially_shipped']\n02:06:50 INFO  run record persisted"
      }
    ]
  },
  {
    "role": "assistant",
    "timestamp": "2026-08-17T02:14:26Z",
    "content": [
      { "type": "text", "text": "The status filter now allows only 'complete', where it previously allowed 'shipped' and 'partially_shipped' as well. That accounts for roughly the missing volume. Checking the counts directly." },
      { "type": "tool_use", "id": "toolu_03cSql", "name": "query_warehouse", "input": { "sql": "select status, count(*) as rows from orders where order_date >= '2026-08-10' group by status order by rows desc", "timeout_s": 60 } }
    ]
  },
  {
    "role": "user",
    "timestamp": "2026-08-17T02:14:41Z",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "toolu_03cSql",
        "content": "[{\"status\":\"complete\",\"rows\":184220},{\"status\":\"shipped\",\"rows\":98330},{\"status\":\"partially_shipped\",\"rows\":24221},{\"status\":\"cancelled\",\"rows\":6104}]"
      }
    ]
  },
  {
    "role": "assistant",
    "timestamp": "2026-08-17T02:14:47Z",
    "content": [
      { "type": "text", "text": "122,551 excluded rows matches shipped plus partially_shipped exactly. Confirming the config change is the only difference before I attribute it." },
      { "type": "tool_use", "id": "toolu_04dCfg", "name": "inspect_config", "input": { "key": "export.status_allowlist", "history": 3 } }
    ]
  },
  {
    "role": "user",
    "timestamp": "2026-08-17T02:14:49Z",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "toolu_04dCfg",
        "content": "[{\"revision\":\"8f21c04\",\"value\":[\"complete\"],\"changed_at\":\"2026-08-15T18:22:11Z\",\"changed_by\":\"deploy-bot\",\"pr\":\"etl-config#412\"},{\"revision\":\"7c02af9\",\"value\":[\"complete\",\"shipped\",\"partially_shipped\"],\"changed_at\":\"2026-05-02T09:41:00Z\"},{\"revision\":\"6be1120\",\"value\":[\"complete\",\"shipped\"],\"changed_at\":\"2026-01-18T11:05:44Z\"}]"
      }
    ]
  },
  {
    "role": "assistant",
    "timestamp": "2026-08-17T02:14:55Z",
    "content": [
      { "type": "text", "text": "Config revision 8f21c04 landed on 15 August through etl-config#412. Running the export validation suite to see whether it flags the narrowed allowlist." },
      { "type": "tool_use", "id": "toolu_05eVal", "name": "run_validation", "input": { "suite": "orders_export", "against": "2026-08-16T02:00Z" } }
    ]
  },
  {
    "role": "user",
    "timestamp": "2026-08-17T02:15:12Z",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "toolu_05eVal",
        "is_error": true,
        "content": "ValidationRunnerError: connection refused by validation-runner.internal:8443 after 3 attempts (15.2s). The runner pool was drained for maintenance window MW-2291 and has no capacity until 06:00Z. No assertions were evaluated."
      }
    ]
  },
  {
    "role": "assistant",
    "timestamp": "2026-08-17T02:15:16Z",
    "content": [
      { "type": "text", "text": "The validation runner is down for maintenance, so I cannot get an independent check that way. I will read the pull request that changed the config instead." },
      { "type": "tool_use", "id": "toolu_06fPr", "name": "read_pull_request", "input": { "repo": "etl-config", "number": 412 } }
    ]
  },
  {
    "role": "user",
    "timestamp": "2026-08-17T02:15:20Z",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "toolu_06fPr",
        "content": "{\"number\":412,\"title\":\"Restrict finance reconciliation export to completed orders\",\"merged_at\":\"2026-08-15T18:22:11Z\",\"files\":[\"exports/finance_reconciliation.yaml\",\"exports/shared_defaults.yaml\"],\"body\":\"Finance only reconciles completed orders. Narrowing the allowlist for their export.\",\"reviewers\":[\"m.okafor\"]}"
      }
    ]
  },
  {
    "role": "assistant",
    "timestamp": "2026-08-17T02:15:28Z",
    "content": [
      { "type": "text", "text": "The change was aimed at the finance export but was written into shared_defaults.yaml, which orders_export also reads. Confirming that inheritance." },
      { "type": "tool_use", "id": "toolu_07gFile", "name": "read_file", "input": { "path": "exports/orders_export.yaml" } }
    ]
  },
  {
    "role": "user",
    "timestamp": "2026-08-17T02:15:31Z",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "toolu_07gFile",
        "content": "name: orders_export\nextends: shared_defaults\nsource: warehouse.orders\npartition: order_date\nfilters:\n  - default_filters\n  - region_filters\n  - status_filters   # inherited from shared_defaults\ndestination: s3://exports/orders/\nschedule: 0 2 * * *"
      }
    ]
  },
  {
    "role": "assistant",
    "timestamp": "2026-08-17T02:15:39Z",
    "content": "orders_export did not lose rows; it started excluding them. etl-config#412 narrowed export.status_allowlist to ['complete'] in exports/shared_defaults.yaml on 15 August, intending to change only the finance reconciliation export. orders_export extends shared_defaults, so it inherited the narrower filter and dropped 122,551 shipped and partially_shipped rows, which matches the warehouse counts exactly. The fix is to move the allowlist override into exports/finance_reconciliation.yaml and leave the shared default as it was. I could not run the validation suite to confirm: the runner is drained until 06:00Z for maintenance window MW-2291."
  }
];

function loadExample() {
  var text = JSON.stringify(EXAMPLE_TRANSCRIPT, null, 2);
  els.input.value = text;
  loadText(text, 'Bundled example');
}

document.getElementById('example-btn').addEventListener('click', loadExample);

loadExample();
