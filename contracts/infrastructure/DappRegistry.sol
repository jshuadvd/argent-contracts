pragma solidity ^0.6.12;

import "./IAuthoriser.sol";
import "./dapp/IFilter.sol";
import "./base/Owned.sol";
import "./storage/Storage.sol";

contract DappRegistry is IAuthoriser, Storage, Owned {

    struct Authorisation {
        bool isActive;
        address filter;
    }
    

    mapping (address => bytes32) public enabledRegistryIds; // [wallet] => [bit array of 256 registry ids]
    mapping (uint8 => mapping (address => Authorisation)) public authorisations; // [registryId] => [contract] => [Authorisation]

    mapping (uint8 => address) public registryManagers; // [registryId] => [manager]

    event RegistryCreated(uint8 registryId, address manager);
    event RegistryRemoved(uint8 registryId);

    function isAuthorised(address _wallet, address _contract, bytes calldata _data) external view override returns (bool) {
        (bool isActive, address filter) = getFilter(_wallet, _contract);
        if (isActive) {
            return _data.length == 0 || filter == address(0) || IFilter(filter).validate(_data);
        }
        return false;
    }

    function toggleRegistry(address _wallet, uint8 _registryId, bool _enabled) external override onlyModule(_wallet) returns (bool) {
        require(_registryId == 0 /* Argent Default Registry */ || registryManagers[_registryId] != address(0), "DR: unknow registry");
        uint registries = uint(enabledRegistryIds[_wallet]);
        bool current = ((registries >> _registryId) & 1) > 0;
        require(current != _enabled, "DR: bad state change" );
        enabledRegistryIds[_wallet] = bytes32(registries ^ (uint(1) << _registryId)); // toggle [_registryId]^th bit
    }

    // Do we want to let the owner to delete a registry?
    function createRegistry(uint8 _registryId, address _manager) external onlyOwner {
        require(_registryId > 0 && _manager != address(0), "DR: invalid parameters");
        require(registryManagers[_registryId] == address(0), "DR: duplicate registry");
        registryManagers[_registryId] = _manager;
        emit RegistryCreated(_registryId, _manager);
    }

    function removeRegistry(uint8 _registryId) external onlyOwner {
        require(_registryId > 0, "DR: invalid _registryId");
        require(registryManagers[_registryId] != address(0), "DR: unknown registry");
        emit RegistryRemoved(_registryId);
    }

    // need to add timelock
    function addAuthorisationToRegistry(uint8 _registryId, address _contract, address _filter) external {
        if (_registryId == 0) { // Argent Default Registry
            require(msg.sender == owner, "DR: not authorised");
        } else {
            address manager = registryManagers[_registryId];
            require(manager != address(0), "DR: unknow registry");
            require(msg.sender == manager, "DR: not authorised");
        }
        authorisations[_registryId][_contract] = Authorisation(true, _filter);
    }

    function getFilter(address _wallet, address _contract) internal view returns (bool, address) {
        uint registries = uint(enabledRegistryIds[_wallet]);
        // Check Argent Default Registry first. It is enabled by default, 
        // i.e. a zero at position 0 of the `registries` bit array means the Argent Registry is enabled)
        if ((registries & 1) == 0 && authorisations[0][_contract].isActive) {
            return (true, authorisations[0][_contract].filter);
        } else {
            for(uint registryId = 1; (registries >> registryId) > 0; registryId++) {
                if(((registries >> registryId) & 1) > 0 && authorisations[uint8(registryId)][_contract].isActive) {
                    return (true, authorisations[uint8(registryId)][_contract].filter);
                }
            }
        }
        return (false, address(0));
    }
}