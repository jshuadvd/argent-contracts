// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.6.12;
pragma experimental ABIEncoderV2;


import "./common/BaseModule.sol";
import "./RelayerManager.sol";
import "./SecurityManager.sol";
import "./TransactionManager.sol";

/**
 * @title ArgentModule
 * @notice Single module for the Argent wallet.
 * @author Julien Niset - <julien@argent.xyz>
 */
contract ArgentModule is BaseModule, RelayerManager, SecurityManager, TransactionManager {

    bytes32 constant NAME = "ArgentModule";

    constructor (
        IModuleRegistry _registry,
        IGuardianStorage _guardianStorage,
        ITransferStorage _userWhitelist,
        IAuthoriser _authoriser,
        address _factory,
        address _weth,
        uint256 _securityPeriod,
        //uint256 _securityWindow, _securityWindow = _recoveryPeriod - _securityPeriod
        uint256 _recoveryPeriod,
        uint256 _lockPeriod
    )
        public
        BaseModule(_registry, _guardianStorage, _userWhitelist, _authoriser, _securityPeriod, NAME)
        SecurityManager(_recoveryPeriod, _lockPeriod)
        RelayerManager(_factory, _weth)
    {
        
    }

    /**
     * @inheritdoc IModule
     */
    function init(address _wallet) external override onlyWallet(_wallet) {
        enableStaticCall(_wallet);
    }

    /**
    * @inheritdoc IModule
    */
    function addModule(address _wallet, address _module) external override onlyWalletOwnerOrSelf(_wallet) onlyWhenUnlocked(_wallet) {
        require(registry.isRegisteredModule(_module), "BM: module is not registered");
        IWallet(_wallet).authoriseModule(_module, true);
    }
    
    /**
     * @inheritdoc RelayerManager
     */
    function getRequiredSignatures(address _wallet, bytes calldata _data) public view override returns (uint256, OwnerSignature) {
        bytes4 methodId = Utils.functionPrefix(_data);

        if (methodId == TransactionManager.multiCallWithSession.selector) {
            return (1, OwnerSignature.Session);
        } 
        if (methodId == TransactionManager.multiCall.selector ||
            methodId == TransactionManager.addToWhitelist.selector ||
            methodId == TransactionManager.removeFromWhitelist.selector ||
            methodId == ArgentModule.addModule.selector ||
            methodId == SecurityManager.addGuardian.selector ||
            methodId == SecurityManager.revokeGuardian.selector ||
            methodId == SecurityManager.cancelGuardianAddition.selector ||
            methodId == RelayerManager.clearSession.selector)
        {
            // owner
            return (1, OwnerSignature.Required);
        } 
        if (methodId == SecurityManager.executeRecovery.selector) {
            // majority of guardians
            uint numberOfSignaturesRequired = Utils.ceil(guardianStorage.guardianCount(_wallet), 2);
            require(numberOfSignaturesRequired > 0, "SM: no guardians set on wallet");
            return (numberOfSignaturesRequired, OwnerSignature.Disallowed);
        }
        if (methodId == SecurityManager.cancelRecovery.selector) {
            // majority of (owner + guardians)
            uint numberOfSignaturesRequired = Utils.ceil(recoveryConfigs[_wallet].guardianCount + 1, 2);
            return (numberOfSignaturesRequired, OwnerSignature.Optional);
        }
        if (methodId == TransactionManager.toggleDappRegistry.selector ||
            methodId == SecurityManager.transferOwnership.selector)
        {
            // owner + majority of guardians
            uint majorityGuardians = Utils.ceil(guardianStorage.guardianCount(_wallet), 2);
            uint numberOfSignaturesRequired = SafeMath.add(majorityGuardians, 1);
            return (numberOfSignaturesRequired, OwnerSignature.Required);
        }
        if (methodId == SecurityManager.finalizeRecovery.selector ||
            methodId == SecurityManager.confirmGuardianAddition.selector ||
            methodId == SecurityManager.confirmGuardianRevokation.selector)
        {
            // anyone
            return (0, OwnerSignature.Anyone);
        }
        if (methodId == SecurityManager.lock.selector || methodId == SecurityManager.unlock.selector) {
            // any guardian
            return (1, OwnerSignature.Disallowed);
        }
        revert("SM: unknown method");
    }
}