const fs = require('fs');
const acorn = require('acorn');

const content = fs.readFileSync('server/src/routes/reply.js', 'utf8');

try {
  acorn.parse(content, {
    ecmaVersion: 2020,
    sourceType: 'module',
    locations: true
  });
  console.log('File parsed successfully!');
} catch (err) {
  console.error('Parse error:');
  console.error(`Line ${err.loc?.line}, Column ${err.loc?.column}`);
  console.error(err.message);
  
  // Show context
  const lines = content.split('\n');
  if (err.loc && err.loc.line) {
    const lineNum = err.loc.line;
    console.error(`\nContext around line ${lineNum}:`);
    for (let i = Math.max(0, lineNum - 3); i < Math.min(lines.length, lineNum + 3); i++) {
      const marker = i === lineNum - 1 ? '>>> ' : '    ';
      console.error(`${marker}${i + 1}: ${lines[i].substring(0, 80)}`);
    }
  }
}
