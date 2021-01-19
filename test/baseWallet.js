/* global artifacts */
const ethers = require("ethers");
const truffleAssert = require("truffle-assertions");

const { getBalance } = require("../utils/utilities.js");

contract.skip("BaseWallet", (accounts) => {
  const owner = accounts[1];
  const nonowner = accounts[2];

  let wallet;
  let walletImplementation;
  let registry;
  let module1;
  let module2;
  let module3;
  let feature1;
  let guardianStorage;
  let lockStorage;

  async function deployTestModule() {
    const module = await VersionManager.new(
      registry.address,
      lockStorage.address,
      guardianStorage.address,
      ethers.constants.AddressZero,
      ethers.constants.AddressZero);
    const feature = await TestFeature.new(
      lockStorage.address,
      module.address,
      42);
    await module.addVersion([feature.address], []);
    return { module, feature };
  }

  before(async () => {
    registry = await Registry.new();
    guardianStorage = await GuardianStorage.new();
    lockStorage = await LockStorage.new();
    const mod = await deployTestModule();
    [module1, feature1] = [mod.module, mod.feature];
    module2 = (await deployTestModule()).module;
    module3 = (await deployTestModule()).module;
    walletImplementation = await BaseWallet.new();
  });

  beforeEach(async () => {
    const proxy = await Proxy.new(walletImplementation.address);
    wallet = await BaseWallet.at(proxy.address);
  });

  describe("Initialize Wallets", () => {
    describe("wallet init", () => {
      it("should create a wallet with the correct owner", async () => {
        let walletOwner = await wallet.owner();
        assert.equal(walletOwner, "0x0000000000000000000000000000000000000000", "owner should be null before init");
        await wallet.init(owner, [module1.address]);
        await module1.upgradeWallet(wallet.address, await module1.lastVersion(), { from: owner });
        walletOwner = await wallet.owner();
        assert.equal(walletOwner, owner, "owner should be the owner after init");
      });

      it("should create a wallet with the correct modules", async () => {
        await wallet.init(owner, [module1.address, module2.address]);
        await module1.upgradeWallet(wallet.address, await module1.lastVersion(), { from: owner });
        await module2.upgradeWallet(wallet.address, await module2.lastVersion(), { from: owner });
        const module1IsAuthorised = await wallet.authorised(module1.address);
        const module2IsAuthorised = await wallet.authorised(module2.address);
        const module3IsAuthorised = await wallet.authorised(module3.address);
        assert.equal(module1IsAuthorised, true, "module1 should be authorised");
        assert.equal(module2IsAuthorised, true, "module2 should be authorised");
        assert.equal(module3IsAuthorised, false, "module3 should not be authorised");
      });

      it("should not reinitialize a wallet", async () => {
        await wallet.init(owner, [module1.address]);
        await module1.upgradeWallet(wallet.address, await module1.lastVersion(), { from: owner });
        await truffleAssert.reverts(wallet.init(owner, [module1.address]), "BW: wallet already initialised");
      });

      it("should not initialize a wallet with no module", async () => {
        await truffleAssert.reverts(wallet.init(owner, []), "BW: construction requires at least 1 module");
      });

      it("should not initialize a wallet with duplicate modules", async () => {
        await truffleAssert.reverts(wallet.init(owner, [module1.address, module1.address]), "BW: module is already added");
      });
    });

    describe("Receiving ETH", () => {
      it("should accept ETH", async () => {
        const before = await getBalance(wallet.address);
        await wallet.send(50000000);
        const after = await getBalance(wallet.address);
        assert.equal(after.sub(before).toNumber(), 50000000, "should have received ETH");
      });

      it("should accept ETH with data", async () => {
        const before = await getBalance(wallet.address);
        await web3.eth.sendTransaction({ from: accounts[0], to: wallet.address, data: "0x1234", value: 50000000 });
        const after = await getBalance(wallet.address);
        assert.equal(after.sub(before).toNumber(), 50000000, "should have received ETH");
      });
    });

    describe("Authorisations", () => {
      it("should not let a non-module deauthorise a module", async () => {
        await wallet.init(owner, [module1.address]);
        await truffleAssert.reverts(wallet.authoriseModule(module1.address, false), "BW: msg.sender not an authorized module");
      });

      it("should not let a feature set the owner to address(0)", async () => {
        await wallet.init(owner, [module1.address]);
        await module1.upgradeWallet(wallet.address, await module1.lastVersion(), { from: owner });

        await truffleAssert.reverts(feature1.invalidOwnerChange(wallet.address), "BW: address cannot be null");
      });
    });

    describe("Static calls", () => {
      it("should delegate static calls to the modules", async () => {
        await wallet.init(owner, [module1.address]);
        await module1.upgradeWallet(wallet.address, await module1.lastVersion(), { from: owner });
        const module1IsAuthorised = await wallet.authorised(module1.address);
        assert.equal(module1IsAuthorised, true, "module1 should be authorised");
        const walletAsFeature = await TestFeature.at(wallet.address);
        const boolVal = await walletAsFeature.getBoolean();
        const uintVal = await walletAsFeature.getUint();
        const addressVal = await walletAsFeature.getAddress(nonowner);
        assert.equal(boolVal, true, "should have the correct bool");
        assert.equal(uintVal, 42, "should have the correct uint");
        assert.equal(addressVal, nonowner, "should have the address");
      });

      it("should not delegate static calls to no longer authorised modules ", async () => {
        await wallet.init(owner, [module1.address, module2.address]);
        await module1.upgradeWallet(wallet.address, await module1.lastVersion(), { from: owner });
        let module1IsAuthorised = await wallet.authorised(module1.address);
        assert.equal(module1IsAuthorised, true, "module1 should be authorised");

        // removing module 1
        const upgrader = await SimpleUpgrader.new(
          registry.address, lockStorage.address, [module1.address], []);
        await registry.registerModule(upgrader.address, ethers.utils.formatBytes32String("Removing module1"));
        await module1.addModule(wallet.address, upgrader.address, { from: owner });
        module1IsAuthorised = await wallet.authorised(module1.address);
        assert.equal(module1IsAuthorised, false, "module1 should not be authorised");

        // trying to execute static call delegated to module1 (it should fail)
        const walletAsModule = await TestFeature.at(wallet.address);
        await truffleAssert.reverts(walletAsModule.getBoolean(), "BW: must be an authorised module for static call");
      });
    });
  });
});
