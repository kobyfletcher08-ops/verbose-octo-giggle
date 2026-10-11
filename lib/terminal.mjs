import readline from 'node:readline/promises';
export async function ask(label) {
  if(!process.stdin.isTTY)throw new Error('Run wallet setup in an interactive terminal.');
  const rl=readline.createInterface({input:process.stdin,output:process.stdout});
  try{return (await rl.question(label)).trim();}finally{rl.close();}
}
export function secret(label) {
  if(!process.stdin.isTTY || typeof process.stdin.setRawMode!=='function')throw new Error('Secret entry requires an interactive terminal.');
  process.stdout.write(label);
  return new Promise((resolve,reject)=>{
    let value=''; const input=process.stdin;
    const wasRaw=input.isRaw; input.setRawMode(true); input.resume(); input.setEncoding('utf8');
    const finish=(err)=>{input.removeListener('data',onData);input.setRawMode(wasRaw);input.pause();process.stdout.write('\n');err?reject(err):resolve(value);};
    const onData=(chunk)=>{
      for(const char of chunk){
        if(char==='\u0003'){finish(new Error('Cancelled.'));return;}
        if(char==='\r'||char==='\n'){finish();return;}
        if(char==='\u007f'||char==='\b'){value=value.slice(0,-1);continue;}
        if(char>=' ' && char!=='\u001b')value+=char;
      }
    };
    input.on('data',onData);
  });
}
