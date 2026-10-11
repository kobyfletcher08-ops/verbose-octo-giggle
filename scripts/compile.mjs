import solc from 'solc';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
export async function compile(extraSources={}) {
  const source=await readFile(new URL('../contracts/AtomicDexArbitrage.sol',import.meta.url),'utf8');
  const output=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',
    sources:{'AtomicDexArbitrage.sol':{content:source},...extraSources},
    settings:{optimizer:{enabled:true,runs:200},evmVersion:'paris',metadata:{bytecodeHash:'none'},
      outputSelection:{'*':{'*':['abi','evm.bytecode.object','evm.deployedBytecode.object','evm.deployedBytecode.immutableReferences']}}}})));
  const errors=(output.errors??[]).filter(e=>e.severity==='error');
  if(errors.length)throw new Error(errors.map(e=>e.formattedMessage).join('\n'));
  return output.contracts;
}
export async function writeArtifact() {
  const output=(await compile())['AtomicDexArbitrage.sol'].AtomicDexArbitrage;
  const artifact={contractName:'AtomicDexArbitrage',compiler:solc.version(),abi:output.abi,
    bytecode:'0x'+output.evm.bytecode.object,runtime:'0x'+output.evm.deployedBytecode.object,
    immutableReferences:output.evm.deployedBytecode.immutableReferences};
  const folder=new URL('../artifacts/',import.meta.url); await mkdir(folder,{recursive:true});
  await writeFile(new URL('AtomicDexArbitrage.json',folder),JSON.stringify(artifact,null,2)+'\n');
  console.log('Compiled AtomicDexArbitrage with '+solc.version());
}
if(process.argv[1]===fileURLToPath(import.meta.url))writeArtifact().catch(e=>{console.error(e.message);process.exitCode=1;});
