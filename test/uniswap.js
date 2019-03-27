const etherlime = require('etherlime');
const Wallet = require("../build/BaseWallet");
const ModuleRegistry = require("../build/ModuleRegistry");
const UniswapFactory = require("../contracts/test/compiled/UniswapFactory");
const UniswapExchange = require("../contracts/test/compiled/UniswapExchange");
const GuardianStorage = require("../build/GuardianStorage");
const UniswapManager = require("../build/UniswapManager");
const ERC20 = require("../build/TestERC20");

const TestManager = require("../utils/test-manager");

describe("Test Uniswap", function () {
    this.timeout(1000000);

    const manager = new TestManager(accounts, 'ganache');

    let infrastructure = accounts[0].signer;
    let owner = accounts[1].signer;

    let wallet, uniswapFactory, uniswapManager, token;

    before(async () => {
        deployer = manager.newDeployer();
        const registry = await deployer.deploy(ModuleRegistry);
        uniswapFactory = await deployer.deploy(UniswapFactory);
        const uniswapTemplateExchange = await deployer.deploy(UniswapExchange);
        await uniswapFactory.initializeFactory(uniswapTemplateExchange.contractAddress); 
        const guardianStorage = await deployer.deploy(GuardianStorage);
        uniswapManager = await deployer.deploy(UniswapManager, {}, registry.contractAddress, guardianStorage.contractAddress, uniswapFactory.contractAddress);
    });

    beforeEach(async () => {
        wallet = await deployer.deploy(Wallet);
        await wallet.init(owner.address, [uniswapManager.contractAddress]);
        token = await deployer.deploy(ERC20, {}, [infrastructure.address], 10000, 18); 
    });

    async function testCreatePool(initialEthLiquidity, initialTokenPrice) {
        let initialTokenAmount = ethers.utils.bigNumberify(initialEthLiquidity).mul(initialTokenPrice);
        await uniswapFactory.from(infrastructure).createExchange(token.contractAddress); 
        const exchangeAddress = await uniswapFactory.getExchange(token.contractAddress); 
        const liquidityPool = await etherlime.ContractAt(UniswapExchange, exchangeAddress);
        await token.from(infrastructure).approve(liquidityPool.contractAddress, initialTokenAmount); 
        const currentBlock = await manager.getCurrentBlock(); 
        const timestamp = await manager.getTimestamp(currentBlock); 
        await liquidityPool.from(infrastructure).addLiquidity(1, initialTokenAmount, timestamp + 300, {value: initialEthLiquidity, gasLimit: 150000});
        const totalSupply = await liquidityPool.totalSupply();  
        const shares = await liquidityPool.balanceOf(infrastructure.address); 
        assert.isTrue(totalSupply.eq(initialEthLiquidity));
        assert.isTrue(shares.eq(totalSupply));
        return liquidityPool;
    };

    async function testAddLiquidity(initialEthLiquidity, initialTokenPrice, ethToAdd, tokenToAdd) {
        if(ethToAdd > 0) {
            await infrastructure.sendTransaction({ to: wallet.contractAddress, value: ethToAdd });
        }
        if(tokenToAdd > 0) {
            await token.from(infrastructure).transfer(wallet.contractAddress, tokenToAdd);
        }
        let ethBefore = await deployer.provider.getBalance(wallet.contractAddress);
        let tokenBefore = await token.balanceOf(wallet.contractAddress);
        let pool = await testCreatePool(initialEthLiquidity, initialTokenPrice);
        await uniswapManager.from(owner).addLiquidityToUniswap(wallet.contractAddress, token.contractAddress, ethToAdd, tokenToAdd, {gasLimit: 300000});
        let shares = await pool.balanceOf(wallet.contractAddress);
        let ethAfter = await deployer.provider.getBalance(wallet.contractAddress);
        let tokenAfter = await token.balanceOf(wallet.contractAddress);
        assert.isTrue(shares.gt(0), "should have received shares");
        assert.isTrue(ethToAdd == 0 ||ethBefore.sub(ethAfter).gte(0.97 * ethToAdd), "should have pooled at least 95% of the eth value provided"); 
        assert.isTrue(tokenToAdd == 0 || tokenBefore.sub(tokenAfter).gte(0.97 * tokenToAdd), "should have pooled at least 95% of the token value provided");
        return [pool, shares];
    };

    async function testRemoveLiquidity(initialEthLiquidity, initialTokenPrice, percentToAdd, percentToremove) {
        let result = await testAddLiquidity(initialEthLiquidity, initialTokenPrice, initialEthLiquidity.mul(percentToAdd).div(100), 0);
        let sharesBefore = result[1];
        let sharesToRemove = sharesBefore.mul(percentToremove).div(100);
        await uniswapManager.from(owner).removeLiquidityFromUniswap(wallet.contractAddress, token.contractAddress, sharesToRemove, {gasLimit: 100000});
        let sharesAfter = await result[0].balanceOf(wallet.contractAddress);
        assert.isTrue(sharesBefore.eq(sharesAfter.add(sharesToRemove)), "should have sold the correct amount of shares");
    }

    describe("Add liquidity ", () => {
        it('should create a liquidity pool with the correct supply', async () => {
            await testCreatePool(ethers.utils.bigNumberify('10000000000000000'), 2);
        });

        it('should add liquidity to the pool whith ETH only when the pool is small (100X)', async () => {
            await testAddLiquidity(ethers.utils.bigNumberify('10000000000'), 2, 100000000, 0);
        });

        it('should add liquidity to the pool whith ETH only when the pool is large (100MX)', async () => {
            await testAddLiquidity(ethers.utils.bigNumberify('10000000000000000'), 2, 1000000, 0);
        });

        it('should add liquidity to the pool whith ETH and some tokens when the pool is small (100X)', async () => {
            await testAddLiquidity(ethers.utils.bigNumberify('10000000000'), 2, 100000000, 100000000);
        });

        it('should add liquidity to the pool whith ETH and some tokens when the pool is large (100MX)', async () => {
            await testAddLiquidity(ethers.utils.bigNumberify('10000000000000000'), 2, 100000000, 100000000);
        });

        it('should add liquidity to the pool whith token only when the pool is small (100X)', async () => {
            await testAddLiquidity(ethers.utils.bigNumberify('10000000000'), 2, 0, 20000000);
        });

        it('should add liquidity to the pool whith token only when the pool is large (100X)', async () => {
            await testAddLiquidity(ethers.utils.bigNumberify('10000000000000000'), 2, 0, 20000000);
        });

        it('should add liquidity to the pool whith token and some ETH when the pool is small (100X)', async () => {
            await testAddLiquidity(ethers.utils.bigNumberify('10000000000'), 2, 5000000, 20000000);
        });

        it('should add liquidity to the pool whith token and some ETH when the pool is large (100MX)', async () => {
            await testAddLiquidity(ethers.utils.bigNumberify('10000000000000000'), 2, 5000000, 20000000);
        });
    });

    describe("Remove liquidity ", () => {
        it('should remove 100% the user shares from the liquidity pool', async () => {
            await testRemoveLiquidity(ethers.utils.bigNumberify('10000000000000000'), 2, 1, 100);
        });

        it('should remove 50% the user shares from the liquidity pool', async () => {
            await testRemoveLiquidity(ethers.utils.bigNumberify('10000000000000000'), 2, 1, 50);
        });

        it('should remove 10% the user shares from the liquidity pool', async () => {
            await testRemoveLiquidity(ethers.utils.bigNumberify('10000000000000000'), 2, 1, 10);
        });

        it('should remove 1% the user shares from the liquidity pool', async () => {
            await testRemoveLiquidity(ethers.utils.bigNumberify('10000000000000000'), 2, 1, 1);
        });
    });

});