// Copyright (C) 2018  Argent Labs Ltd. <https://argent.xyz>

// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.

// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.6.12;
pragma experimental ABIEncoderV2;

import "./common/Utils.sol";
import "./common/BaseModule.sol";
import "../../lib/other/ERC20.sol";

/**
 * @title TransactionManager
 * @notice Module to execute transactions to e.g. transfer tokens (ETH or ERC20) or call third-party contracts.
 * @author Julien Niset - <julien@argent.xyz>
 */
abstract contract TransactionManager is BaseModule {

    bytes4 private constant ERC1271_ISVALIDSIGNATURE = bytes4(keccak256("isValidSignature(bytes32,bytes)"));
    bytes4 private constant ERC721_RECEIVED = bytes4(keccak256("onERC721Received(address,address,uint256,bytes)"));
    bytes4 private constant ERC1155_RECEIVED = bytes4(keccak256("onERC1155Received(address,address,uint256,uint256,bytes)"));
    bytes4 private constant ERC1155_BATCH_RECEIVED = bytes4(keccak256("onERC1155BatchReceived(address,address,uint256[],uint256[],bytes)"));

    struct Call {
        address to;
        uint256 value;
        bytes data;
        bool isSpenderInData;
    }

    // *************** Events *************************** //

    event Transfer(address indexed wallet, address indexed token, uint256 indexed amount, address to, bytes data);
    event CalledContract(address indexed wallet, address indexed to, uint256 amount, bytes data);
    event AddedToWhitelist(address indexed wallet, address indexed target, uint64 whitelistAfter);
    event RemovedFromWhitelist(address indexed wallet, address indexed target);
    event ToggledDappRegistry(address indexed _wallet, bytes32 _registry, bool isEnabled);
    event ERC1155TokenReceiverEnabled(address indexed _wallet);

    // *************** External functions ************************ //

    function multiCall(
        address _wallet,
        Call[] calldata _transactions
    )
        external
        onlySelf()
        onlyWhenUnlocked(_wallet)
        returns (bytes[] memory)
    {
        bytes[] memory results = new bytes[](_transactions.length);
        for(uint i = 0; i < _transactions.length; i++) {
            address spender = recoverSpender(_wallet, _transactions[i]);
            require(
                isWhitelisted(_wallet, spender) ||
                isAuthorised(_wallet, spender, _transactions[i].to, _transactions[i].data),
                "TM: call not authorised");
            results[i] = invokeWallet(_wallet, _transactions[i].to, _transactions[i].value, _transactions[i].data);
        }
        return results;
    }

    function multiCallWithSession(
        address _wallet,
        Session calldata,
        Call[] calldata _transactions
    )
        external
        onlySelf()
        onlyWhenUnlocked(_wallet)
        returns (bytes[] memory)
    {
        bytes[] memory results = new bytes[](_transactions.length);
        for(uint i = 0; i < _transactions.length; i++) {
            results[i] = invokeWallet(_wallet, _transactions[i].to, _transactions[i].value, _transactions[i].data);
        }
        return results;
    }

    /**
     * @notice Adds an address to the whitelist of a wallet.
     * @param _wallet The target wallet.
     * @param _target The address to add.
     */
    function addToWhitelist(
        address _wallet,
        address _target
    )
        external
        onlyWalletOwnerOrSelf(_wallet)
        onlyWhenUnlocked(_wallet)
    {
        require(!isWhitelisted(_wallet, _target), "TT: target already whitelisted");

        uint256 whitelistAfter = block.timestamp.add(securityPeriod);
        setWhitelist(_wallet, _target, whitelistAfter);
        emit AddedToWhitelist(_wallet, _target, uint64(whitelistAfter));
    }

    /**
     * @notice Removes an address from the whitelist of a wallet.
     * @param _wallet The target wallet.
     * @param _target The address to remove.
     */
    function removeFromWhitelist(
        address _wallet,
        address _target
    )
        external
        onlyWalletOwnerOrSelf(_wallet)
        onlyWhenUnlocked(_wallet)
    {
        setWhitelist(_wallet, _target, 0);
        emit RemovedFromWhitelist(_wallet, _target);
    }

    function toggleDappRegistry(
        address _wallet,
        bytes32 _registry
    )   
        external
        onlySelf()
        onlyWhenUnlocked(_wallet)
    {
        bool isEnabled = authoriser.toggle(_wallet, _registry);
        emit ToggledDappRegistry(_wallet, _registry, isEnabled);
    }

    /**
    * @notice Checks if an address is whitelisted for a wallet.
    * @param _wallet The target wallet.
    * @param _target The address.
    * @return _isWhitelisted true if the address is whitelisted.
    */
    function isWhitelisted(
        address _wallet,
        address _target
    )
        public
        view
        returns (bool _isWhitelisted)
    {
        uint whitelistAfter = userWhitelist.getWhitelist(_wallet, _target);
        return whitelistAfter > 0 && whitelistAfter < block.timestamp;
    }

    /**
    * @notice Enable the static calls required to make the wallet compatible with the ERC1155TokenReceiver 
    * interface (see https://eips.ethereum.org/EIPS/eip-1155#erc-1155-token-receiver). This method only 
    * needs to be called for wallets deployed in version lower or equal to 2.4.0 as the ERC1155 static calls
    * are not available by default for these versions of BaseWallet
    * @param _wallet The target wallet.
    */
    function enableERC1155TokenReceiver(
        address _wallet
    )   
        external
        onlySelf()
    {
        IWallet(_wallet).enableStaticCall(address(this), ERC1155_RECEIVED);
        IWallet(_wallet).enableStaticCall(address(this), ERC1155_BATCH_RECEIVED);
        emit ERC1155TokenReceiverEnabled(_wallet);
    }

    /**
     * @inheritdoc IModule
     */
    function supportsStaticCall(
        bytes4 _methodId
    ) 
        external 
        view
        override
        returns (bool _isSupported)
    {
        return _methodId == ERC1271_ISVALIDSIGNATURE ||
               _methodId == ERC721_RECEIVED ||
               _methodId == ERC1155_RECEIVED ||
               _methodId == ERC1155_BATCH_RECEIVED;
    }

    /** ******************* Callbacks ************************** */

    /**
    * @notice Implementation of EIP 1271.
    * Should return whether the signature provided is valid for the provided data.
    * @param _msgHash Hash of a message signed on the behalf of address(this)
    * @param _signature Signature byte array associated with _msgHash
    */
    function isValidSignature(
        bytes32 _msgHash,
        bytes memory _signature
    ) 
        external
        view
        returns (bytes4)
    {
        require(_signature.length == 65, "TM: invalid signature length");
        address signer = Utils.recoverSigner(_msgHash, _signature, 0);
        require(_isOwner(msg.sender, signer), "TM: Invalid signer");
        return ERC1271_ISVALIDSIGNATURE;
    }


    fallback() external {
        bytes4 methodId = Utils.functionPrefix(msg.data);
        if(methodId == ERC721_RECEIVED || methodId == ERC1155_RECEIVED || methodId == ERC1155_BATCH_RECEIVED) {
            // solhint-disable-next-line no-inline-assembly
            assembly {                
                calldatacopy(0, 0, 0x04)
                return (0, 0x20)
            }
        }
    }

    // *************** Internal Functions ********************* //

    function enableDefaultStaticCalls(address _wallet) internal {
        // setup the static calls that are available for free for all wallets
        IWallet(_wallet).enableStaticCall(address(this), ERC1271_ISVALIDSIGNATURE);
        IWallet(_wallet).enableStaticCall(address(this), ERC721_RECEIVED);
    }

    function recoverSpender(address _wallet, Call calldata _transaction) internal pure returns (address) {
        if (_transaction.isSpenderInData) {
            require(_transaction.value == 0, "TM: unsecure call with spender in data");
            // transfer(to, value), transferFrom(wallet, to, value),
            (address first, address second) = abi.decode(_transaction.data[4:], (address, address));
            return first == _wallet ? second : first;
        }   
        return _transaction.to;
    }

    function isAuthorised(address _wallet, address _spender, address _to, bytes calldata _data) internal view returns (bool) {
        if (_to == _spender) {
            return authoriser.authorise(_wallet, _to, _data); // do we need to block calls to the wallet or modules?
        } else {
            return authoriser.authorise(_wallet, _spender, "");
        }
    }

    function setWhitelist(address _wallet, address _target, uint256 _whitelistAfter) internal {
        userWhitelist.setWhitelist(_wallet, _target, _whitelistAfter);
    }
}