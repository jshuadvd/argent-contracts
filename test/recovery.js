/* global artifacts */

const ethers = require("ethers");
const chai = require("chai");
const BN = require("bn.js");
const bnChai = require("bn-chai");

const { assert } = chai;
chai.use(bnChai(BN));

const Proxy = artifacts.require("Proxy");
const BaseWallet = artifacts.require("BaseWallet");
const Registry = artifacts.require("ModuleRegistry");
const TransferStorage = artifacts.require("TransferStorage");
const GuardianStorage = artifacts.require("GuardianStorage");
const ArgentModule = artifacts.require("ArgentModule");
const Authoriser = artifacts.require("DappRegistry");
const UniswapV2Router01 = artifacts.require("DummyUniV2Router");

const utils = require("../utils/utilities.js");
const { ARGENT_WHITELIST } = require("../utils/utilities.js");

const ZERO_ADDRESS = ethers.constants.AddressZero;
const SECURITY_PERIOD = 2;
const SECURITY_WINDOW = 2;
const LOCK_PERIOD = 4;
const RECOVERY_PERIOD = 4;

const RelayManager = require("../utils/relay-manager");

contract("ArgentModule", (accounts) => {
  let manager;

  const infrastructure = accounts[0];
  const owner = accounts[1];
  const guardian1 = accounts[2];
  const newowner = accounts[5];
  const relayer = accounts[9];

  let registry;
  let guardianStorage;
  let transferStorage;
  let module;
  let wallet;
  let walletImplementation;
  let authoriser;

  before(async () => {
    registry = await Registry.new();

    guardianStorage = await GuardianStorage.new();
    transferStorage = await TransferStorage.new();

    authoriser = await Authoriser.new();

    const uniswapRouter = await UniswapV2Router01.new();

    module = await ArgentModule.new(
      registry.address,
      guardianStorage.address,
      transferStorage.address,
      authoriser.address,
      uniswapRouter.address,
      SECURITY_PERIOD,
      SECURITY_WINDOW,
      LOCK_PERIOD,
      RECOVERY_PERIOD);

    await registry.registerModule(module.address, ethers.utils.formatBytes32String("ArgentModule"));
    await authoriser.addAuthorisationToRegistry(ARGENT_WHITELIST, relayer, ZERO_ADDRESS);

    walletImplementation = await BaseWallet.new();

    manager = new RelayManager(guardianStorage.address, ZERO_ADDRESS);
  });

  beforeEach(async () => {
    const proxy = await Proxy.new(walletImplementation.address);
    wallet = await BaseWallet.at(proxy.address);
    await wallet.init(owner, [module.address]);

    await wallet.send(new BN("1000000000000000000"));
  });

  async function addGuardians(guardians) {
    // guardians can be BaseWallet or ContractWrapper objects
    for (const guardian of guardians) {
      await module.addGuardian(wallet.address, guardian, { from: owner });
    }

    await utils.increaseTime(30);
    for (let i = 1; i < guardians.length; i += 1) {
      await module.confirmGuardianAddition(wallet.address, guardians[i]);
    }
    const count = (await module.guardianCount(wallet.address)).toNumber();
    assert.equal(count, guardians.length, `${guardians.length} guardians should be added`);
  }

  describe("recover wallet", () => {
    it("should recover wallet with 1 guardian", async () => {
      await addGuardians([guardian1]);

      const txReceipt = await manager.relay(
        module,
        "executeRecovery",
        [wallet.address, newowner],
        wallet,
        [guardian1]);
      const success = await utils.parseRelayReceipt(txReceipt).success;
      assert.isTrue(success, "execute recovery failed");
      console.log("Gas to execute recovery: ", txReceipt.gasUsed);

      await utils.increaseTime(40);

      const tx = await module.finalizeRecovery(wallet.address, { from: infrastructure });
      const walletOwner = await wallet.owner();
      assert.equal(walletOwner, newowner, "wallet owner should have been changed");
      console.log("Gas to finalize recovery: ", tx.receipt.gasUsed);
    });
  });
});
