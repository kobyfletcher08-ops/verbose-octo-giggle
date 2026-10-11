// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface IERC20Minimal {
    function balanceOf(address) external view returns (uint256);
}
interface IV2Router {
    function swapExactTokensForTokens(uint256,uint256,address[] calldata,address,uint256)
        external returns (uint256[] memory);
}
interface IFlashPool {
    function flashLoanSimple(address,address,uint256,bytes calldata,uint16) external;
}

/// Two direct V2 DEX swaps in one transaction. Owner, tokens and routers are immutable.
/// minProfit is denominated in quote tokens; the caller must include its gas budget.
contract AtomicDexArbitrage {
    address public immutable owner;
    address public immutable quoteToken;
    address public immutable assetToken;
    address public immutable flashPool;
    address public immutable routerA;
    address public immutable routerB;
    uint256 private entered;
    bytes32 private activeRequest;
    bool private callbackUsed;

    struct Trade {
        address buyRouter;
        address sellRouter;
        uint256 amountIn;
        uint256 minAssetOut;
        uint256 minQuoteOut;
        uint256 minProfit;
        uint256 deadline;
    }

    error Unauthorized();
    error InvalidTrade();
    error Unprofitable();
    error InvalidCallback();
    error TokenCallFailed();
    error Reentrant();
    event Executed(bool flashLoan,address buyRouter,address sellRouter,uint256 amountIn,uint256 profit,uint256 premium);

    constructor(address owner_,address quote_,address asset_,address pool_,address a_,address b_) {
        if (owner_ == address(0) || quote_ == asset_ || a_ == b_ ||
            quote_.code.length == 0 || asset_.code.length == 0 ||
            a_.code.length == 0 || b_.code.length == 0 ||
            (pool_ != address(0) && pool_.code.length == 0)) revert InvalidTrade();
        owner=owner_; quoteToken=quote_; assetToken=asset_; flashPool=pool_; routerA=a_; routerB=b_;
    }
    modifier onlyOwner() { if (msg.sender != owner) revert Unauthorized(); _; }
    modifier locked() { if (entered != 0) revert Reentrant(); entered=1; _; entered=0; }

    function _validate(Trade memory t) private view {
        if (t.amountIn == 0 || t.minAssetOut == 0 || t.minProfit == 0 ||
            t.deadline < block.timestamp || t.deadline > block.timestamp + 120 ||
            !((t.buyRouter == routerA && t.sellRouter == routerB) ||
              (t.buyRouter == routerB && t.sellRouter == routerA))) revert InvalidTrade();
    }
    function _tokenCall(address token,bytes memory data) private {
        (bool ok,bytes memory out)=token.call(data);
        if (!ok || (out.length != 0 && !abi.decode(out,(bool)))) revert TokenCallFailed();
    }
    function _approve(address token,address spender,uint256 amount) private {
        _tokenCall(token,abi.encodeWithSignature("approve(address,uint256)",spender,0));
        if (amount != 0) _tokenCall(token,abi.encodeWithSignature("approve(address,uint256)",spender,amount));
    }
    function _transfer(address token,address to,uint256 amount) private {
        _tokenCall(token,abi.encodeWithSignature("transfer(address,uint256)",to,amount));
    }
    function _roundTrip(Trade memory t) private {
        uint256 assetBefore=IERC20Minimal(assetToken).balanceOf(address(this));
        address[] memory path=new address[](2);
        path[0]=quoteToken; path[1]=assetToken;
        _approve(quoteToken,t.buyRouter,t.amountIn);
        IV2Router(t.buyRouter).swapExactTokensForTokens(t.amountIn,t.minAssetOut,path,address(this),t.deadline);
        _approve(quoteToken,t.buyRouter,0);
        uint256 bought=IERC20Minimal(assetToken).balanceOf(address(this))-assetBefore;
        if (bought < t.minAssetOut) revert InvalidTrade();
        path[0]=assetToken; path[1]=quoteToken;
        _approve(assetToken,t.sellRouter,bought);
        IV2Router(t.sellRouter).swapExactTokensForTokens(bought,t.minQuoteOut,path,address(this),t.deadline);
        _approve(assetToken,t.sellRouter,0);
        if (IERC20Minimal(assetToken).balanceOf(address(this)) != assetBefore) revert InvalidTrade();
    }
    function executeFunded(Trade calldata t) external onlyOwner locked returns (uint256 profit) {
        _validate(t);
        uint256 beforeBalance=IERC20Minimal(quoteToken).balanceOf(address(this));
        _tokenCall(quoteToken,abi.encodeWithSignature("transferFrom(address,address,uint256)",owner,address(this),t.amountIn));
        if (IERC20Minimal(quoteToken).balanceOf(address(this)) != beforeBalance+t.amountIn) revert InvalidTrade();
        _roundTrip(t);
        uint256 afterBalance=IERC20Minimal(quoteToken).balanceOf(address(this));
        if (afterBalance < beforeBalance+t.amountIn+t.minProfit) revert Unprofitable();
        profit=afterBalance-beforeBalance-t.amountIn;
        _transfer(quoteToken,owner,t.amountIn+profit);
        emit Executed(false,t.buyRouter,t.sellRouter,t.amountIn,profit,0);
    }
    function executeFlash(Trade calldata t) external onlyOwner locked returns (uint256 profit) {
        _validate(t);
        if (flashPool == address(0)) revert InvalidTrade();
        uint256 beforeBalance=IERC20Minimal(quoteToken).balanceOf(address(this));
        bytes memory params=abi.encode(t,beforeBalance);
        activeRequest=keccak256(params); callbackUsed=false;
        IFlashPool(flashPool).flashLoanSimple(address(this),quoteToken,t.amountIn,params,0);
        if (!callbackUsed) revert InvalidCallback();
        activeRequest=bytes32(0); callbackUsed=false;
        _approve(quoteToken,flashPool,0);
        uint256 afterBalance=IERC20Minimal(quoteToken).balanceOf(address(this));
        if (afterBalance < beforeBalance+t.minProfit) revert Unprofitable();
        profit=afterBalance-beforeBalance;
        _transfer(quoteToken,owner,profit);
    }
    function executeOperation(address asset,uint256 amount,uint256 premium,address initiator,bytes calldata params)
        external returns (bool) {
        if (msg.sender != flashPool || initiator != address(this) || entered != 1 ||
            activeRequest == bytes32(0) || activeRequest != keccak256(params) || callbackUsed ||
            asset != quoteToken) revert InvalidCallback();
        callbackUsed=true;
        (Trade memory t,uint256 beforeBalance)=abi.decode(params,(Trade,uint256));
        if (amount != t.amountIn || IERC20Minimal(quoteToken).balanceOf(address(this)) != beforeBalance+amount)
            revert InvalidCallback();
        _roundTrip(t);
        uint256 afterBalance=IERC20Minimal(quoteToken).balanceOf(address(this));
        if (afterBalance < beforeBalance+amount+premium+t.minProfit) revert Unprofitable();
        _approve(quoteToken,flashPool,amount+premium);
        emit Executed(true,t.buyRouter,t.sellRouter,amount,afterBalance-beforeBalance-amount-premium,premium);
        return true;
    }
    function rescue(address token,uint256 amount) external onlyOwner locked { _transfer(token,owner,amount); }
}
