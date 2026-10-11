// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @notice Minimal, immutable EIP-7702 delegate for self-custody rescue.
 * @dev Designed to be executed at the user's EOA via 7702. Never call this
 *      contract directly with funds. The EOA's own signature approves exactly
 *      one asset, minimum balance, recipient, deadline, nonce and chain.
 *      UNAUDITED - TEST BEFORE DELEGATING ANY VALUABLE ACCOUNT.
 */
contract RescueDelegate {
    bytes32 private constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant RESCUE_TYPEHASH = keccak256(
        "Rescue(address token,address destination,uint256 minAmount,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant NAME_HASH = keccak256("SelfRescue7702");
    bytes32 private constant VERSION_HASH = keccak256("1");
    // EIP-7201-inspired, namespaced slot. Storage lives on the delegated EOA.
    bytes32 private constant NONCE_SLOT = bytes32(
        uint256(keccak256("selfrescue7702.used-nonces.v1")) - 1
    );

    event Recovered(address indexed token, address indexed destination, uint256 amount, uint256 nonce);

    function _slotFor(uint256 nonce) internal pure returns (bytes32) {
        return keccak256(abi.encode(nonce, NONCE_SLOT));
    }

    function alreadyUsed(uint256 nonce) external view returns (bool used) {
        bytes32 slot = _slotFor(nonce);
        assembly { used := sload(slot) }
    }

    function rescue(
        address token, address payable destination, uint256 minAmount,
        uint256 nonce, uint256 deadline, bytes calldata signature
    ) external {
        require(block.timestamp <= deadline, "EXPIRED");
        require(destination != address(0) && destination != address(this), "BAD_DESTINATION");
        require(signature.length == 65, "BAD_SIGNATURE_LENGTH");
        bytes32 slot = _slotFor(nonce);
        uint256 used;
        assembly { used := sload(slot) }
        require(used == 0, "REPLAY");

        bytes32 domain = keccak256(abi.encode(
            DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)
        ));
        bytes32 structHash = keccak256(abi.encode(
            RESCUE_TYPEHASH, token, destination, minAmount, nonce, deadline
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domain, structHash));
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (v < 27) v += 27;
        require((v == 27 || v == 28) && uint256(s) <=
            0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0,
            "INVALID_ECDSA");
        require(ecrecover(digest, v, r, s) == address(this), "NOT_OWNER");
        assembly { sstore(slot, 1) }

        uint256 amount;
        if (token == address(0)) {
            amount = address(this).balance;
            require(amount >= minAmount && amount > 0, "INSUFFICIENT_BALANCE");
            (bool ok,) = destination.call{value: amount}("");
            require(ok, "NATIVE_TRANSFER_FAILED");
        } else {
            require(token.code.length > 0, "INVALID_TOKEN");
            (bool ok, bytes memory ret) = token.staticcall(
                abi.encodeWithSignature("balanceOf(address)", address(this))
            );
            require(ok && ret.length >= 32, "BALANCE_QUERY_FAILED");
            amount = abi.decode(ret, (uint256));
            require(amount >= minAmount && amount > 0, "INSUFFICIENT_BALANCE");
            (ok, ret) = token.call(
                abi.encodeWithSignature("transfer(address,uint256)", destination, amount)
            );
            require(ok && (ret.length == 0 || (ret.length >= 32 && abi.decode(ret, (bool)))),
                "TOKEN_TRANSFER_FAILED");
        }
        emit Recovered(token, destination, amount, nonce);
    }

    receive() external payable {}
}
