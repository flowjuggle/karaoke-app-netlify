const fs = require('fs');
const path = require('path');

const buildDir = path.join(__dirname, '..', 'netlify');
const publicDir = path.join(__dirname, '..', 'public');

function ensure(dir){ if(!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
function copy(src, dest){ fs.copyFileSync(src, dest); }

(async ()=>{
  ensure(buildDir);
  // copy css
  copy(path.join(publicDir, 'styles.css'), path.join(buildDir, 'styles.css'));
  // copy netlify-specific app already provided
  if(fs.existsSync(path.join(publicDir, 'index.html'))){
    // generate a netlify-friendly index from public/index.html by replacing script src
    let html = fs.readFileSync(path.join(publicDir, 'index.html'),'utf8');
    html = html.replace('/app.js', 'app.netlify.js').replace('/styles.css', 'styles.css');
    fs.writeFileSync(path.join(buildDir, 'index.html'), html);
  }
  console.log('Copied to', buildDir);
})();
