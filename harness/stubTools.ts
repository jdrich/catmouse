// Schemas only. The harness never executes these.
// Attacker never sees this list.

export const STUB_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file from disk.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write a file to disk.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          contents: { type: 'string' },
        },
        required: ['path', 'contents'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a shell command.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'http_request',
      description: 'Make an HTTP request.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          method: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a file.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
];
