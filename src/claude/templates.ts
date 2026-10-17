// CLAUDE.md starter templates offered by the CLAUDE.md manager. Generated verbatim from the pre-TypeScript server.js (L3025-3128).
export const CLAUDEMD_TEMPLATES: Record<string, string> = {
  basic: `# Project Guidelines

## Overview
Brief description of the project.

## Architecture
Key architecture decisions and patterns.

## Code Style
- Prefer X over Y
- Follow existing patterns in the codebase

## Testing
How to run tests, what to test.

## Important Notes
Things to remember when working on this project.
`,
  webdev: `# Web Project Guidelines

## Stack
- Frontend: [framework]
- Backend: [framework]
- Database: [database]

## Development
\`\`\`bash
npm install
npm run dev
\`\`\`

## Code Style
- Use TypeScript strict mode
- Components in PascalCase
- Utilities in camelCase

## API Conventions
- RESTful endpoints at /api/
- Always validate input
- Return consistent error shapes

## Testing
\`\`\`bash
npm test
npm run test:e2e
\`\`\`

## Deployment
- Branch: main → production
- PRs require review
`,
  cli: `# CLI Tool Guidelines

## Overview
What this CLI does and who uses it.

## Development
\`\`\`bash
npm install
npm link  # for local testing
\`\`\`

## Architecture
- Entry point: src/index.ts
- Commands in src/commands/
- Shared utils in src/lib/

## Adding Commands
1. Create file in src/commands/
2. Export handler function
3. Register in src/index.ts

## Testing
\`\`\`bash
npm test
\`\`\`
`,
  python: `# Python Project Guidelines

## Setup
\`\`\`bash
python -m venv venv
source venv/bin/activate  # or venv\\Scripts\\activate on Windows
pip install -r requirements.txt
\`\`\`

## Code Style
- Follow PEP 8
- Type hints on all public functions
- Docstrings on classes and public methods

## Testing
\`\`\`bash
pytest
pytest --cov
\`\`\`

## Project Structure
- src/ — main source code
- tests/ — test files
- scripts/ — utility scripts
`,
};
