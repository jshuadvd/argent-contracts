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
const ERC721 = artifacts.require("TestERC721");
const UniswapV2Router01 = artifacts.require("DummyUniV2Router");

const ERC20 = artifacts.require("TestERC20");

const utils = require("../utils/utilities.js");
const { ETH_TOKEN, ARGENT_WHITELIST } = require("../utils/utilities.js");

const ZERO_BYTES32 = ethers.constants.HashZero;
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
  const recipient = accounts[4];
  const nonceInitialiser = accounts[5];
  const relayer = accounts[9];

  let registry;
  let transferStorage;
  let guardianStorage;
  let module;
  let wallet;
  let walletImplementation;
  let erc20;
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

    const decimals = 12; // number of decimal for TOKN contract
    erc20 = await ERC20.new([infrastructure, wallet.address], 10000000, decimals); // TOKN contract with 10M tokens (5M TOKN for wallet and 5M TOKN for account[0])
    await wallet.send(new BN("1000000000000000000"));
  });

  async function encodeTransaction(to, value, data, isSpenderInData = false) {
    return { to, value, data, isSpenderInData };
  }

  async function whitelist(target) {
    await module.addToWhitelist(wallet.address, target, { from: owner });
    await utils.increaseTime(3);
    const isTrusted = await module.isWhitelisted(wallet.address, target);
    assert.isTrue(isTrusted, "should be trusted after the security period");
  }

  async function initNonce() {
    // add to whitelist
    await whitelist(nonceInitialiser);
    // set the relayer nonce to > 0
    const transaction = await encodeTransaction(nonceInitialiser, 1, ZERO_BYTES32, false);
    const txReceipt = await manager.relay(
      module,
      "multiCall",
      [wallet.address, [transaction]],
      wallet,
      [owner]);
    const success = await utils.parseRelayReceipt(txReceipt).success;
    assert.isTrue(success, "transfer failed");
    const nonce = await module.getNonce(wallet.address);
    assert.isTrue(nonce.gt(0), "nonce init failed");
  }

  describe("whitelist", () => {
    beforeEach(async () => {
      await initNonce();
    });
    it("should whitelist an address", async () => {
      const target = accounts[6];
      const txReceipt = await manager.relay(
        module,
        "addToWhitelist",
        [wallet.address, target],
        wallet,
        [owner]);
      const success = await utils.parseRelayReceipt(txReceipt).success;
      assert.isTrue(success, "transfer failed");
      await utils.increaseTime(3);
      const isTrusted = await module.isWhitelisted(wallet.address, target);
      assert.isTrue(isTrusted, "should be trusted after the security period");
      console.log(`Gas for whitelisting: ${txReceipt.gasUsed}`);
    });
  });

  describe("transfer ETH", () => {
    beforeEach(async () => {
      await initNonce();
    });

    it("should send ETH to a whitelisted address", async () => {
      await whitelist(recipient);
      const balanceStart = await utils.getBalance(recipient);

      const transaction = await encodeTransaction(recipient, 10, ZERO_BYTES32, false);

      const txReceipt = await manager.relay(
        module,
        "multiCall",
        [wallet.address, [transaction]],
        wallet,
        [owner],
        1,
        ETH_TOKEN,
        relayer);
      const success = await utils.parseRelayReceipt(txReceipt).success;
      assert.isTrue(success, "transfer failed");
      const balanceEnd = await utils.getBalance(recipient);
      assert.equal(balanceEnd.sub(balanceStart), 10, "should have received ETH");

      console.log(`Gas for ETH transfer: ${txReceipt.gasUsed}`);
    });
  });

  describe("transfer/Approve ERC20", () => {
    beforeEach(async () => {
      await initNonce();
      // init erc20 - recipient storage slot
      await erc20.transfer(recipient, new BN("100"));
    });

    it("should send ERC20 to a whitelisted address", async () => {
      await whitelist(recipient);
      const balanceStart = await erc20.balanceOf(recipient);

      const data = erc20.contract.methods.transfer(recipient, 100).encodeABI();
      const transaction = await encodeTransaction(erc20.address, 0, data, true);

      const txReceipt = await manager.relay(
        module,
        "multiCall",
        [wallet.address, [transaction]],
        wallet,
        [owner],
        1,
        ETH_TOKEN,
        relayer);
      const success = await utils.parseRelayReceipt(txReceipt).success;
      assert.isTrue(success, "transfer failed");
      const balanceEnd = await erc20.balanceOf(recipient);
      assert.equal(balanceEnd.sub(balanceStart), 100, "should have received tokens");
      console.log(`Gas for EC20 transfer: ${txReceipt.gasUsed}`);
    });

    it("should approve ERC20 for a whitelisted address", async () => {
      await whitelist(recipient);

      const data = erc20.contract.methods.approve(recipient, 100).encodeABI();
      const transaction = await encodeTransaction(erc20.address, 0, data, true);

      const txReceipt = await manager.relay(
        module,
        "multiCall",
        [wallet.address, [transaction]],
        wallet,
        [owner],
        1,
        ETH_TOKEN,
        relayer);
      const success = await utils.parseRelayReceipt(txReceipt).success;
      assert.isTrue(success, "transfer failed");
      const balance = await erc20.allowance(wallet.address, recipient);
      assert.equal(balance, 100, "should have been approved tokens");
      console.log(`Gas for EC20 approve: ${txReceipt.gasUsed}`);
    });
  });

  describe("transfer ERC721", () => {
    let erc721;
    const tokenId = 7;

    beforeEach(async () => {
      await initNonce();

      erc721 = await ERC721.new();
      await erc721.mint(wallet.address, tokenId);
    });

    it("should send an ERC721 to a whitelisted address", async () => {
      await whitelist(recipient);

      const data = erc721.contract.methods.safeTransferFrom(wallet.address, recipient, tokenId).encodeABI();
      const transaction = await encodeTransaction(erc721.address, 0, data, true);

      const txReceipt = await manager.relay(
        module,
        "multiCall",
        [wallet.address, [transaction]],
        wallet,
        [owner],
        1,
        ETH_TOKEN,
        relayer);
      const success = await utils.parseRelayReceipt(txReceipt).success;
      assert.isTrue(success, "transfer failed");
      console.log(`Gas for ERC721 transfer: ${txReceipt.gasUsed}`);
    });
  });
});
