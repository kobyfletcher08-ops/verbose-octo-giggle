// Published Atlas v1 EIP-7702 delegate by Byzantine-Finance.
// Upstream: https://github.com/Byzantine-Finance/Atlas/blob/main/src/Atlas.sol
import {getAddress, isAddress, ZeroAddress, verifyAuthorization, verifyTypedData, Interface, Signature, keccak256, toUtf8Bytes} from 'ethers';
import {asUInt} from './common.mjs';
export const ATLAS_ADDRESS = getAddress('0x3d965CFdDA791589cCAB955498D509f2F7E30b79');
export const ATLAS_ABI = [
  'function executeCall((address to,uint256 value,bytes data) call,uint256 deadline,uint256 nonce,uint8 v,bytes32 r,bytes32 s) payable',
  'function isNonceUsed(uint256 nonce) view returns (bool)',
];
export const ATLAS_IFACE=new Interface(ATLAS_ABI);
export const ERC20_IFACE=new Interface(['function transfer(address,uint256) returns(bool)']);
export const ATLAS_TYPES={
  Call:[{name:'to',type:'address'},{name:'value',type:'uint256'},{name:'data',type:'bytes'}],
  ExecuteCall:[{name:'call',type:'Call'},{name:'deadline',type:'uint256'},{name:'nonce',type:'uint256'}]
};
export const atlasDomain=(owner,chainId)=>({name:'Byzantine',version:'1',chainId,verifyingContract:owner});
const AUTH_MAX=(1n<<64n)-1n;
export function makeAtlasCall(token,destination,amount){
  const amt=asUInt(amount,'amount',true);
  if(token===ZeroAddress)return {to:getAddress(destination),value:amt.toString(),data:'0x'};
  return {to:getAddress(token),value:'0',data:ERC20_IFACE.encodeFunctionData('transfer',[getAddress(destination),amt])};
}
export function checkAtlasPackage(p, now=Math.floor(Date.now()/1000)){
  if(!p||typeof p!=='object'||Array.isArray(p)||p.version!==2||p.implementation!=='atlas')throw Error('Unsupported Atlas rescue package');
  if(!isAddress(p.owner)||!isAddress(p.delegate)||!isAddress(p.rescue?.token)||!isAddress(p.rescue?.destination))throw Error('Invalid Atlas job addresses');
  if(getAddress(p.delegate)!==ATLAS_ADDRESS)throw Error('Unrecognized Atlas implementation address');
  const owner=getAddress(p.owner),dest=getAddress(p.rescue.destination),token=getAddress(p.rescue.token);
  if(owner===dest)throw Error('Safe wallet must differ from compromised owner');
  if(!/^0x[0-9a-fA-F]{64}$/.test(p.delegateCodeHash||''))throw Error('Missing Atlas deployed code hash');
  const chainId=asUInt(p.chainId,'chainId',true), amount=asUInt(p.rescue.minAmount,'amount',true);
  const deadline=asUInt(p.rescue.deadline,'deadline',true), nonce=asUInt(p.rescue.nonce,'nonce');
  if(chainId>BigInt(Number.MAX_SAFE_INTEGER))throw Error('Chain ID too large');
  if(deadline<=BigInt(now)||deadline>BigInt(now+7*86400))throw Error('Signed rescue deadline outside next 7 days');
  if(!Array.isArray(p.auths)||p.auths.length!==2)throw Error('Two authorizations (clear then Atlas) required');
  const auths=p.auths.map((a,i)=>{
    if(!a||!isAddress(a.address)||typeof a.signature!=='string'||!/^0x[0-9a-fA-F]{130}$/.test(a.signature))throw Error('Bad authorization');
    const n=asUInt(a.nonce,'authorization nonce');
    if(n>=AUTH_MAX)throw Error('Authorization nonce too large');
    if(asUInt(a.chainId,'authorization chain')!==chainId)throw Error('Authorization chain mismatch');
    const expected=i===0?ZeroAddress:ATLAS_ADDRESS;
    if(getAddress(a.address)!==expected)throw Error('Authorization order must be clear then redelegate');
    if(getAddress(verifyAuthorization({address:expected,chainId,nonce:n},a.signature))!==owner)throw Error('Invalid owner authorization');
    return {address:expected,nonce:n,chainId,signature:a.signature};
  });
  if(auths[1].nonce!==auths[0].nonce+1n)throw Error('Authorizations must have consecutive nonces');
  const call=makeAtlasCall(token,dest,amount), advertised=p.atlasCall;
  if(!advertised||getAddress(advertised.to)!==call.to||String(advertised.value)!==call.value||String(advertised.data).toLowerCase()!==call.data.toLowerCase())throw Error('Atlas operation is not an exact signed transfer to safe wallet');
  if(!/^0x[0-9a-fA-F]{130}$/.test(p.rescue.signature||''))throw Error('Bad signed Atlas call');
  const recovered=verifyTypedData(atlasDomain(owner,chainId),ATLAS_TYPES,{call,deadline,nonce},p.rescue.signature);
  if(getAddress(recovered)!==owner)throw Error('Atlas operation not signed by original wallet');
  const id=keccak256(toUtf8Bytes(JSON.stringify([p.chainId,owner,dest,p.rescue.nonce,p.rescue.signature]))).slice(2,14);
  return {id,version:2,implementation:'atlas',owner,delegate:ATLAS_ADDRESS,chainId:Number(chainId),delegateCodeHash:p.delegateCodeHash.toLowerCase(),auths,atlasCall:call,rescue:{token,destination:dest,minAmount:amount,nonce,deadline,signature:p.rescue.signature}};
}
export function atlasToJob(p){return {...p,chainId:String(p.chainId),auths:p.auths.map(a=>({...a,chainId:a.chainId.toString(),nonce:a.nonce.toString()})),rescue:{...p.rescue,minAmount:p.rescue.minAmount.toString(),nonce:p.rescue.nonce.toString(),deadline:p.rescue.deadline.toString()}}}
export function atlasExecution(job){const sig=Signature.from(job.rescue.signature);return ATLAS_IFACE.encodeFunctionData('executeCall',[
 {to:job.atlasCall.to,value:BigInt(job.atlasCall.value),data:job.atlasCall.data},
 BigInt(job.rescue.deadline),BigInt(job.rescue.nonce),sig.v,sig.r,sig.s
]);}
