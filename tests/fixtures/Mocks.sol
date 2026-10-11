// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
// Local tests only. These mocks and their wallets must never be deployed for trading.
interface IMockToken {
    function transfer(address,uint256) external returns(bool);
    function transferFrom(address,address,uint256) external returns(bool);
    function balanceOf(address) external view returns(uint256);
}
interface IReceiver { function executeOperation(address,uint256,uint256,address,bytes calldata) external returns(bool); }
contract MockToken {
    uint8 public immutable decimals;
    mapping(address=>uint256) public balanceOf;
    mapping(address=>mapping(address=>uint256)) public allowance;
    constructor(uint8 d){decimals=d;}
    function mint(address to,uint256 n) external {balanceOf[to]+=n;}
    function approve(address to,uint256 n) external returns(bool){allowance[msg.sender][to]=n;return true;}
    function transfer(address to,uint256 n) external returns(bool){balanceOf[msg.sender]-=n;balanceOf[to]+=n;return true;}
    function transferFrom(address from,address to,uint256 n) external returns(bool){allowance[from][msg.sender]-=n;balanceOf[from]-=n;balanceOf[to]+=n;return true;}
}
contract MockPair {
    address public immutable token0;
    address public immutable token1;
    uint112 private reserve0;
    uint112 private reserve1;
    constructor(address q,address a,uint112 rq,uint112 ra){token0=q;token1=a;reserve0=rq;reserve1=ra;}
    function getReserves() external view returns(uint112,uint112,uint32){return(reserve0,reserve1,uint32(block.timestamp));}
    function setReserves(uint112 q,uint112 a) external {reserve0=q;reserve1=a;}
}
contract MockFactory {
    address public pair;
    constructor(address p){pair=p;}
    function getPair(address,address) external view returns(address){return pair;}
}
contract MockRouter {
    address public immutable factory;
    address public immutable WETH;
    MockPair public immutable pair;
    uint256 public haircutBps;
    constructor(address f,address a,address p){factory=f;WETH=a;pair=MockPair(p);}
    function setHaircut(uint256 bps) external {haircutBps=bps;}
    function getAmountsOut(uint256 amount,address[] calldata path) public view returns(uint256[] memory out){
        require(path.length==2,"path");
        (uint112 q,uint112 a,)=pair.getReserves();
        bool forward=path[0]==pair.token0();
        uint256 inputReserve=forward?q:a;
        uint256 outputReserve=forward?a:q;
        uint256 withFee=amount*9970;
        out=new uint256[](2);out[0]=amount;out[1]=withFee*outputReserve/(inputReserve*10000+withFee);
    }
    function swapExactTokensForTokens(uint256 amount,uint256 minimum,address[] calldata path,address to,uint256 deadline)
        external returns(uint256[] memory out){
        require(block.timestamp<=deadline,"deadline");
        out=getAmountsOut(amount,path);out[1]=out[1]*(10000-haircutBps)/10000;
        require(out[1]>=minimum,"slippage");
        require(IMockToken(path[0]).transferFrom(msg.sender,address(this),amount),"in");
        require(IMockToken(path[1]).transfer(to,out[1]),"out");
        (uint112 q,uint112 a,)=pair.getReserves();
        if(path[0]==pair.token0())pair.setReserves(uint112(uint256(q)+amount),uint112(uint256(a)-out[1]));
        else pair.setReserves(uint112(uint256(q)-out[1]),uint112(uint256(a)+amount));
    }
}
contract MockFlashPool {
    uint128 public FLASHLOAN_PREMIUM_TOTAL=5;
    uint256 public configuration=(1<<56)|(1<<63);
    bool public duplicate;
    function setConfiguration(uint256 value) external {configuration=value;}
    function getConfiguration(address) external view returns(uint256){return configuration;}
    function setDuplicate(bool value) external {duplicate=value;}
    function flashLoanSimple(address receiver,address token,uint256 amount,bytes calldata params,uint16) external {
        require(IMockToken(token).transfer(receiver,amount),"loan");
        uint256 premium=(amount*FLASHLOAN_PREMIUM_TOTAL+5000)/10000;
        require(IReceiver(receiver).executeOperation(token,amount,premium,msg.sender,params),"callback");
        if(duplicate)IReceiver(receiver).executeOperation(token,amount,premium,msg.sender,params);
        require(IMockToken(token).transferFrom(receiver,address(this),amount+premium),"repay");
    }
    function maliciousCallback(address receiver,address token,bytes calldata params) external {
        IReceiver(receiver).executeOperation(token,100,0,receiver,params);
    }
}
contract MockGasOracle {
    uint256 public fee=10000000000000;
    uint32 public operatorFeeScalar;
    uint64 public operatorFeeConstant;
    function getL1Fee(bytes calldata) external view returns(uint256){return fee;}
    function setFee(uint256 value) external {fee=value;}
}
