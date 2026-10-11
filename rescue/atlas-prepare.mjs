// Run this ONLY on a trusted local computer. NEVER put the owner key in Telegram/Render.
// Usage: node rescue/atlas-prepare.mjs --rpc HTTPS_RPC --chain 8453 --safe 0x... --token native|0x... --amount RAW_UINT --expected-codehash 0x... [--out signed.json] [--hours 24]
import {Wallet,JsonRpcProvider,ZeroAddress,randomBytes,hexlify,keccak256,getAddress} from 'ethers';
import {writeFile} from 'node:fs/promises';
import {parseHttps,asUInt} from './common.mjs';
import {ATLAS_ADDRESS,ATLAS_TYPES,atlasDomain,makeAtlasCall,checkAtlasPackage} from './atlas.mjs';
const pairs=process.argv.slice(2);
const opt={};for(let i=0;i<pairs.length;i+=2){if(!pairs[i]?.startsWith('--')||!pairs[i+1])throw Error('Arguments must be --key value pairs');opt[pairs[i].slice(2)]=pairs[i+1]}
const rpc=parseHttps(opt.rpc||'');
const provider=new JsonRpcProvider(rpc,undefined,{batchMaxCount:1,cacheTimeout:-1});
const chainId=(await provider.getNetwork()).chainId;
if(opt.chain&&chainId!==asUInt(opt.chain,'chain',true))throw Error('Chain ID mismatch');
if(!/^0x[0-9a-fA-F]{64}$/.test(opt['expected-codehash']||''))throw Error('Required: --expected-codehash from independently verified Atlas deployed bytecode (not a chat message)');
const actual=await provider.getCode(ATLAS_ADDRESS);
if(actual==='0x'||keccak256(actual).toLowerCase()!==opt['expected-codehash'].toLowerCase())throw Error('Atlas not deployed or its bytecode does not match the independently verified expected code hash');
const key=process.env.RESCUE_OWNER_PRIVATE_KEY;
if(!/^0x[0-9a-fA-F]{64}$/.test(key||''))throw Error('RESCUE_OWNER_PRIVATE_KEY required LOCALLY only, never in Render/GitHub/Telegram');
const owner=new Wallet(key,provider);const destination=getAddress(opt.safe);if(destination===owner.address)throw Error('Destination must be different from source');
const token=opt.token==='native'?ZeroAddress:getAddress(opt.token);
const amount=asUInt(opt.amount,'amount',true),hours=Number(opt.hours||24);
if(!Number.isSafeInteger(hours)||hours<1||hours>168)throw Error('Hours must be 1-168');
const existingCode=(await provider.getCode(owner.address)).toLowerCase();
if(existingCode!=='0x'&&!/^0xef0100[0-9a-f]{40}$/.test(existingCode))throw Error('Refusing non-EIP-7702 code on source wallet');
const start=BigInt(await provider.getTransactionCount(owner.address,'pending'));
if(start>=(1n<<64n)-2n)throw Error('Owner nonce too high for two authorizations');
// EIP-7702 explicitly allows consecutive authorizations for the same EOA in one type-4 tx.
// ZeroAddress clears any existing delegation; second tuple installs Atlas. No gap between transactions.
const clear=await owner.authorize({address:ZeroAddress,nonce:start,chainId});
const replace=await owner.authorize({address:ATLAS_ADDRESS,nonce:start+1n,chainId});
const deadline=BigInt(Math.floor(Date.now()/1000+hours*3600));
const nonce=BigInt(hexlify(randomBytes(32)));
const call=makeAtlasCall(token,destination,amount);
const signature=await owner.signTypedData(atlasDomain(owner.address,chainId),ATLAS_TYPES,{call,deadline,nonce});
const packageData={version:2,implementation:'atlas',chainId:chainId.toString(),owner:owner.address,delegate:ATLAS_ADDRESS,delegateCodeHash:keccak256(actual),auths:[clear,replace].map(a=>({address:a.address,nonce:a.nonce.toString(),chainId:a.chainId.toString(),signature:a.signature.serialized})),atlasCall:call,rescue:{token,destination,minAmount:amount.toString(),nonce:nonce.toString(),deadline:deadline.toString(),signature}};
checkAtlasPackage(packageData);
const filename=opt.out||`rescue-atlas-${chainId}-${owner.address.slice(2,10)}.json`;
await writeFile(filename,JSON.stringify(packageData,null,2),{mode:0o600,flag:'wx'});
console.log('Signed Atlas package saved:',filename);
console.log('Existing delegate:',existingCode==='0x'?'none':`0x${existingCode.slice(8)}`);
console.log('Atomic auths: clear old delegation at nonce',start.toString(),'then redelegate to Atlas at nonce',(start+1n).toString());
console.log('Safe recipient:',destination,'asset:',token,'FIXED raw units:',amount.toString());
console.log('Wallet secret is not in the JSON, but signed instructions are sensitive. Upload only to your private owner bot.');
console.log('IMPORTANT: These auths are nonce-bound. If owner nonce advances, discard and re-sign. Failed execution can STILL change delegation.');
