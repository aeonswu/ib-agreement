const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("IBAgreement", () => {
  const toWei = ethers.utils.parseEther;
  const usdAddress = '0x0000000000000000000000000000000000000348';

  const collateralFactor = toWei('0.5');
  const liquidationFactor = toWei('0.75');

  let accounts;
  let executor, executorAddress;
  let borrower, borrowerAddress;
  let governor, governorAddress;
  let user, userAddress;

  let ibAgreement;
  let underlying;
  let underlying2;
  let cyToken;
  let cyToken2;
  let priceOracle;
  let comptroller;
  let collateral;
  let registry;
  let priceFeed;
  let token;
  let converter;
  let converter2;
  let invalidConverter;

  beforeEach(async () => {
    accounts = await ethers.getSigners();
    executor = accounts[1];
    executorAddress = await executor.getAddress();
    borrower = accounts[2];
    borrowerAddress = await borrower.getAddress();
    governor = accounts[3];
    governorAddress = await governor.getAddress();
    user = accounts[4];
    userAddress = await user.getAddress();

    const ibAgreementFactory = await ethers.getContractFactory("IBAgreementV2");
    const tokenFactory = await ethers.getContractFactory("MockToken");
    const cyTokenFactory = await ethers.getContractFactory("MockCyToken");
    const priceOracleFactory = await ethers.getContractFactory("MockPriceOralce");
    const comptrollerFactory = await ethers.getContractFactory("MockComptroller");
    const registryFactory = await ethers.getContractFactory("MockRegistry");
    const priceFeedFactory = await ethers.getContractFactory("ChainlinkPriceFeed");
    const converterFactory = await ethers.getContractFactory("MockConverter");

    priceOracle = await priceOracleFactory.deploy();
    comptroller = await comptrollerFactory.deploy(priceOracle.address);
    underlying = await tokenFactory.deploy("USD Tether", "USDT", 6);
    underlying2 = await tokenFactory.deploy("Wrapped Ether", "WETH", 18);
    cyToken = await cyTokenFactory.deploy(comptroller.address, underlying.address);
    cyToken2 = await cyTokenFactory.deploy(comptroller.address, underlying2.address);
    collateral = await tokenFactory.deploy("Wrapped BTC", "WBTC", 8);
    registry = await registryFactory.deploy();
    priceFeed = await priceFeedFactory.deploy(registry.address, collateral.address, collateral.address, usdAddress);
    ibAgreement = await ibAgreementFactory.deploy(executorAddress, borrowerAddress, governorAddress, comptroller.address, collateral.address, priceFeed.address, collateralFactor, liquidationFactor);
    await comptroller.setMarketListed(cyToken.address, true);
    await comptroller.pushAssetsIn(ibAgreement.address, cyToken.address);

    token = await tokenFactory.deploy("Token", "TOKEN", 18);
    converter = await converterFactory.deploy(collateral.address, underlying.address);
    converter2 = await converterFactory.deploy(collateral.address, underlying2.address);
    invalidConverter = await converterFactory.deploy(token.address, underlying.address);
  });

  describe('debtUSD / hypotheticalDebtUSD', () => {
    const debt = 5000 * 1e6; // 5000 USDT
    const price = '1000000000000000000000000000000'; // 1e30

    beforeEach(async () => {
      await Promise.all([
        cyToken.setBorrowBalance(ibAgreement.address, debt),
        priceOracle.setUnderlyingPrice(cyToken.address, price)
      ]);
    });

    it('shows the debt in USD value', async () => {
      expect(await ibAgreement.debtUSD()).to.eq(toWei('5000'));
    });

    it('shows the hypothetical debt in USD value', async () => {
      const borrowAmount = 1000 * 1e6; // 1000 USDT
      expect(await ibAgreement.hypotheticalDebtUSD(cyToken.address, borrowAmount)).to.eq(toWei('6000'));
    });
  });

  describe('collateralUSD / hypotheticalCollateralUSD / liquidationThreshold', () => {
    const amount = 1 * 1e8; // 1 wBTC
    const price = '4000000000000'; // 40000 * 1e8

    beforeEach(async () => {
      await Promise.all([
        collateral.mint(ibAgreement.address, amount),
        registry.setPrice(collateral.address, usdAddress, price),
        ibAgreement.connect(governor).setPriceFeed(priceFeed.address)
      ]);
    });

    it('shows the collateral in USD value', async () => {
      expect(await ibAgreement.collateralUSD()).to.eq(toWei('20000')); // CF: 50%
    });

    it('shows the hypothetical debt in USD value', async () => {
      const withdrawAmount = 0.5 * 1e8; // 0.5 wBTC
      expect(await ibAgreement.hypotheticalCollateralUSD(withdrawAmount)).to.eq(toWei('10000')); // CF: 50%
    });

    it('show the liquidation threshold', async () => {
      expect(await ibAgreement.liquidationThreshold()).to.eq(toWei('30000')); // LF: 75%
    });
  });

  describe('borrow / borrowMax / withdraw / repay', () => {
    const collateralAmount = 1 * 1e8; // 1 wBTC
    const collateralPrice = '4000000000000'; // 40000 * 1e8
    const borrowAmount = 100 * 1e6; // 100 USDT
    const borrowPrice = '1000000000000000000000000000000'; // 1e30

    beforeEach(async () => {
      await Promise.all([
        collateral.mint(ibAgreement.address, collateralAmount),
        registry.setPrice(collateral.address, usdAddress, collateralPrice),
        ibAgreement.connect(governor).setPriceFeed(priceFeed.address),
        priceOracle.setUnderlyingPrice(cyToken.address, borrowPrice)
      ]);
      expect(await ibAgreement.collateralUSD()).to.eq(toWei('20000')); // CF: 50%
    });

    it('borrows successfully', async () => {
      await ibAgreement.connect(borrower).borrow(cyToken.address, borrowAmount);
      expect(await ibAgreement.debtUSD()).to.eq(toWei('100'));
    });

    it('failed to borrow for non-borrower', async () => {
      await expect(ibAgreement.borrow(cyToken.address, borrowAmount)).to.be.revertedWith('caller is not the borrower');
      expect(await ibAgreement.debtUSD()).to.eq(0);
    });

    it('failed to borrow for undercollateralized', async () => {
      const amount = 20001 * 1e6; // collateral is 20000
      await expect(ibAgreement.connect(borrower).borrow(cyToken.address, amount)).to.be.revertedWith('undercollateralized');
      expect(await ibAgreement.debtUSD()).to.eq(0);
    });

    it('failed to borrow for unknown reason', async () => {
      await cyToken.setBorrowFailed(true);
      await expect(ibAgreement.connect(borrower).borrow(cyToken.address, borrowAmount)).to.be.revertedWith('borrow failed');
      expect(await ibAgreement.debtUSD()).to.eq(0);
    });

    it('borrows max successfully', async () => {
      await ibAgreement.connect(borrower).borrowMax(cyToken.address);
      expect(await ibAgreement.debtUSD()).to.eq(toWei('20000'));
    });

    it('borrows max successfully (rounding test)', async () => {
      const newCollateralPrice = '3999999999999'; // 39999.9 * 1e8
      await registry.setPrice(collateral.address, usdAddress, newCollateralPrice);

      await ibAgreement.connect(borrower).borrowMax(cyToken.address);
      expect(await ibAgreement.debtUSD()).to.gt(toWei('19999'));
      expect(await ibAgreement.debtUSD()).to.lt(await ibAgreement.collateralUSD());
    });

    it('failed to borrow max for non-borrower', async () => {
      await expect(ibAgreement.borrowMax(cyToken.address)).to.be.revertedWith('caller is not the borrower');
      expect(await ibAgreement.debtUSD()).to.eq(0);
    });

    it('failed to borrow max for undercollateralized', async () => {
      await ibAgreement.connect(borrower).borrowMax(cyToken.address);
      expect(await ibAgreement.debtUSD()).to.eq(toWei('20000'));

      const newCollateralPrice = '3999999999999'; // 39999.9 * 1e8
      await registry.setPrice(collateral.address, usdAddress, newCollateralPrice);

      await expect(ibAgreement.connect(borrower).borrowMax(cyToken.address)).to.be.revertedWith('undercollateralized');
      expect(await ibAgreement.debtUSD()).to.eq(toWei('20000'));
    });

    it('repays successfully', async () => {
      await ibAgreement.connect(borrower).borrow(cyToken.address, borrowAmount);
      expect(await ibAgreement.debtUSD()).to.eq(toWei('100'));

      await underlying.connect(borrower).approve(ibAgreement.address, borrowAmount);
      await ibAgreement.connect(borrower).repay(cyToken.address, borrowAmount);
      expect(await ibAgreement.debtUSD()).to.eq(0);
    });

    it('failed to repay for non-borrower', async () => {
      await expect(ibAgreement.repay(cyToken.address, borrowAmount)).to.be.revertedWith('caller is not the borrower');
    });

    it('failed to repay for unknown reason', async () => {
      await ibAgreement.connect(borrower).borrow(cyToken.address, borrowAmount);
      expect(await ibAgreement.debtUSD()).to.eq(toWei('100'));

      await underlying.connect(borrower).approve(ibAgreement.address, borrowAmount);
      await cyToken.setRepayFailed(true);
      await expect(ibAgreement.connect(borrower).repay(cyToken.address, borrowAmount)).to.be.revertedWith('repay failed');
      expect(await ibAgreement.debtUSD()).to.eq(toWei('100'));
    });

    it('withdraws successfully', async () => {
      await ibAgreement.connect(borrower).withdraw(collateralAmount);
      expect(await ibAgreement.collateralUSD()).to.eq(0);
    });

    it('failed to withdraw for non-borrower', async () => {
      await expect(ibAgreement.withdraw(collateralAmount)).to.be.revertedWith('caller is not the borrower');
      expect(await ibAgreement.collateralUSD()).to.eq(toWei('20000')); // CF: 50%
    });

    it('failed to withdraw for undercollateralized', async () => {
      const amount = 2 * 1e8; // 2 wBTC
      await expect(ibAgreement.withdraw(amount)).to.be.revertedWith('caller is not the borrower');
      expect(await ibAgreement.collateralUSD()).to.eq(toWei('20000')); // CF: 50%
    });
  });

  describe('seize', async () => {
    const collateralAmount = 1 * 1e8; // 1 wBTC
    const amount = toWei('1'); // 1 CREAM

    beforeEach(async () => {
      await Promise.all([
        collateral.mint(ibAgreement.address, collateralAmount),
        token.mint(ibAgreement.address, amount)
      ]);
    });

    it('seizes successfully', async () => {
      await ibAgreement.connect(executor).seize(token.address, amount);
      expect(await token.balanceOf(executorAddress)).to.eq(amount);
    });

    it('failed to seize for non-executor', async () => {
      await expect(ibAgreement.seize(token.address, amount)).to.be.revertedWith('caller is not the executor');
      expect(await token.balanceOf(executorAddress)).to.eq(0);
    });

    it('failed to seize collateral', async () => {
      await expect(ibAgreement.connect(executor).seize(collateral.address, amount)).to.be.revertedWith('seize collateral not allow');
    });
  });

  describe('liquidate / liquidateFull', async () => {
    const collateralAmount = 1 * 1e8; // 1 wBTC
    const collateralPrice = '4000000000000'; // 40000 * 1e8
    const borrowAmount = 20000 * 1e6; // 20000 USDT
    const borrowPrice = '1000000000000000000000000000000'; // 1e30

    beforeEach(async () => {
      await Promise.all([
        collateral.mint(ibAgreement.address, collateralAmount),
        registry.setPrice(collateral.address, usdAddress, collateralPrice),
        ibAgreement.connect(governor).setPriceFeed(priceFeed.address),
        priceOracle.setUnderlyingPrice(cyToken.address, borrowPrice)
      ]);
      await ibAgreement.connect(borrower).borrow(cyToken.address, borrowAmount);
      expect(await ibAgreement.collateralUSD()).to.eq(toWei('20000')); // CF: 50%
      expect(await ibAgreement.liquidationThreshold()).to.eq(toWei('30000')); // LF: 75%
      expect(await ibAgreement.debtUSD()).to.eq(toWei('20000'));
    });

    it('liquidates successfully', async () => {
      const newCollateralPrice = '2666600000000'; // 26666 * 1e8
      const newNormalizedCollateralPrice = '26666'; // for converter
      const amount = 0.5 * 1e8; // 0.5 wBTC
      await registry.setPrice(collateral.address, usdAddress, newCollateralPrice);
      await converter.setPrice(newNormalizedCollateralPrice);
      await ibAgreement.connect(executor).setConverter([cyToken.address], [converter.address]);
      expect(await ibAgreement.collateralUSD()).to.eq(toWei('13333')); // $26666, CF: 50%, $13333
      expect(await ibAgreement.liquidationThreshold()).to.eq(toWei('19999.5')); // $26666, LF: 75%, $19999.5
      expect(await ibAgreement.debtUSD()).to.eq(toWei('20000')); // $20000 > $19999.5, liquidatable

      await ibAgreement.connect(executor).liquidate(cyToken.address, amount, 0);

      expect(await ibAgreement.collateralUSD()).to.eq(toWei('6666.5')); // 0.5 wBTC remain, $13333, CF: 50%, $6666.5
      expect(await ibAgreement.liquidationThreshold()).to.eq(toWei('9999.75')); // 0.5 wBTC remain, $13333, LF: 75%, $9999.75
      expect(await ibAgreement.debtUSD()).to.eq(toWei('6667')); // 0.5 wBTC liquidated, $13333, $20000 - $13333 = $6667 debt remain, $6667 < $9999.75, not liquidatable
    });

    it('liquidates full successfully', async () => {
      const newCollateralPrice = '2666600000000'; // 26666 * 1e8
      const newNormalizedCollateralPrice = '26666'; // for converter
      await registry.setPrice(collateral.address, usdAddress, newCollateralPrice);
      await converter.setPrice(newNormalizedCollateralPrice);
      await ibAgreement.connect(executor).setConverter([cyToken.address], [converter.address]);
      expect(await ibAgreement.collateralUSD()).to.eq(toWei('13333')); // $26666, CF: 50%, $13333
      expect(await ibAgreement.liquidationThreshold()).to.eq(toWei('19999.5')); // $26666, LF: 75%, $19999.5
      expect(await ibAgreement.debtUSD()).to.eq(toWei('20000')); // $20000 > $19999.5, liquidatable

      await ibAgreement.connect(executor).liquidateFull(cyToken.address, collateralAmount);

      expect(await ibAgreement.collateralUSD()).to.eq(toWei('3333.00000625')); // $20000 ~= 0.75 * $26666, ~0.25 wBTC remain, ~$6666, CF: 50%, ~$3333
      expect(await ibAgreement.liquidationThreshold()).to.eq(toWei('4999.500009375')); // $20000 ~= 0.75 * $26666, ~0.25 wBTC remain, ~$6666, LF: 75%, ~$4999
      expect(await ibAgreement.debtUSD()).to.eq(0); // must be 0 debt
    });

    it('failed to liquidate for non-executor', async () => {
      const amount = 0.5 * 1e8; // 0.5 wBTC
      await expect(ibAgreement.liquidate(cyToken.address, amount, 0)).to.be.revertedWith('caller is not the executor');
    });

    it('failed to liquidate for not liquidatable', async () => {
      const amount = 0.5 * 1e8; // 0.5 wBTC
      await expect(ibAgreement.connect(executor).liquidate(cyToken.address, amount, 0)).to.be.revertedWith('not liquidatable');
    });

    it('failed to liquidate for empty converter', async () => {
      const newCollateralPrice = '2666600000000'; // 26666 * 1e8
      const amount = 0.5 * 1e8; // 0.5 wBTC
      await registry.setPrice(collateral.address, usdAddress, newCollateralPrice);
      expect(await ibAgreement.collateralUSD()).to.eq(toWei('13333')); // $26666, CF: 50%, $13333
      expect(await ibAgreement.liquidationThreshold()).to.eq(toWei('19999.5')); // $26666, LF: 75%, $19999.5
      expect(await ibAgreement.debtUSD()).to.eq(toWei('20000')); // $20000 > $19999.5, liquidatable

      await expect(ibAgreement.connect(executor).liquidate(cyToken.address, amount, 0)).to.be.revertedWith('empty converter');
    });

    it('failed to liquidate full for too much collateral needed', async () => {
      const newCollateralPrice = '2666600000000'; // 26666 * 1e8
      const newNormalizedCollateralPrice = '26666'; // for converter
      const maxCollateralAmount = 0.5 * 1e8; // 0.5 wBTC
      await registry.setPrice(collateral.address, usdAddress, newCollateralPrice);
      await converter.setPrice(newNormalizedCollateralPrice);
      await ibAgreement.connect(executor).setConverter([cyToken.address], [converter.address]);
      expect(await ibAgreement.collateralUSD()).to.eq(toWei('13333')); // $26666, CF: 50%, $13333
      expect(await ibAgreement.liquidationThreshold()).to.eq(toWei('19999.5')); // $26666, LF: 75%, $19999.5
      expect(await ibAgreement.debtUSD()).to.eq(toWei('20000')); // $20000 > $19999.5, liquidatable

      await expect(ibAgreement.connect(executor).liquidateFull(cyToken.address, maxCollateralAmount)).to.be.revertedWith('too much collateral needed');
    });
  });

  describe('setConverter', async () => {
    it('sets converters successfully', async () => {
      await ibAgreement.connect(executor).setConverter([cyToken.address, cyToken2.address], [converter.address, converter2.address]);
      expect(await ibAgreement.converters(cyToken.address)).to.eq(converter.address);
      expect(await ibAgreement.converters(cyToken2.address)).to.eq(converter2.address);
    });

    it('failed to set converters for non-executor', async () => {
      await expect(ibAgreement.setConverter([cyToken.address, cyToken2.address], [converter.address, converter2.address])).to.be.revertedWith('caller is not the executor');
    });

    it('failed to set converters for length mismatch', async () => {
      await expect(ibAgreement.connect(executor).setConverter([cyToken.address, cyToken2.address], [converter.address])).to.be.revertedWith('length mismatch');
    });

    it('failed to set converters for empty converter', async () => {
      await expect(ibAgreement.connect(executor).setConverter([cyToken.address, cyToken2.address], [converter.address, ethers.constants.AddressZero])).to.be.revertedWith('empty converter');
    });

    it('failed to set converters for mismatch source token', async () => {
      await expect(ibAgreement.connect(executor).setConverter([cyToken.address, cyToken2.address], [converter.address, invalidConverter.address])).to.be.revertedWith('mismatch source token');
    });

    it('failed to set converters for mismatch destination token', async () => {
      await expect(ibAgreement.connect(executor).setConverter([cyToken.address, cyToken2.address], [converter.address, converter.address])).to.be.revertedWith('mismatch destination token');
    });
  });

  describe('setPriceFeed', async () => {
    it('sets price feed successfully', async () => {
      await ibAgreement.connect(governor).setPriceFeed(priceFeed.address);
      expect(await ibAgreement.priceFeed()).to.eq(priceFeed.address);
    });

    it('failed to set price feed for non-governor', async () => {
      await expect(ibAgreement.setPriceFeed(priceFeed.address)).to.be.revertedWith('caller is not the governor');
    });
  });
});
