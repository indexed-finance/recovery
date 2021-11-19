import { ethers, waffle } from 'hardhat';
import { expect } from "chai";
import { IDelegateCallProxyManager, IndexPoolRecovery, MockImplementation, IRootChainManager, ITokenPredicate, IERC20, IProxyManagerAccessControl, IERC20Metadata } from '../typechain';
import { computeUniswapPairAddress, createSnapshot, deployContract, getContract, impersonate, sendEtherTo, withSigner } from './shared';
import { ContractTransaction } from '@ethersproject/contracts';
import {
  corePoolImplementationID,
  sigmaPoolImplementationID,
  coreSellerImplementationID,
  coreControllerAddress,
  sigmaControllerAddress,
  defi5Tokens,
  cc10Tokens,
  fffTokens,
  cc10SellerTokens,
  defi5,
  cc10,
  fff,
  cc10Seller,
  treasury,
} from './shared';
import { formatEther, formatUnits } from '@ethersproject/units';
import { BigNumber } from 'ethers';


describe("IndexPoolRecovery", function() {
  const [wallet, wallet1] = waffle.provider.getWallets()
  let proxyManagerAccessControl: IProxyManagerAccessControl
  let proxyManager: IDelegateCallProxyManager
  let recovery: IndexPoolRecovery
  let polygonRootChainManager: IRootChainManager;
  let polygonERC20Predicate: ITokenPredicate;
  let coreControllerImplementation: MockImplementation;
  let sigmaControllerImplementation: MockImplementation;
  let corePoolImplementation: MockImplementation;
  // let sigmaPoolImplementation: MockImplementation;
  const coreSellerImplementation = '0x2F0869D7AFd6638d2c83Fb2bfD79d5956D0cB952';
  const sigmaPoolImplementation = '0xf0204D5aEA78F7d9EbE0E0c4fB21fA67426BFefc';
  const sideChainDepositAmount = BigNumber.from(2).pow(128).sub(1);
  let weth: IERC20;
  let reset: () => Promise<void>

  before(async () => {
    proxyManager = await getContract('0xD23DeDC599bD56767e42D48484d6Ca96ab01C115', 'IDelegateCallProxyManager')
    proxyManagerAccessControl = await getContract('0x3D4860d4b7952A3CAD3Accfada61463F15fc0D54', 'IProxyManagerAccessControl')
    coreControllerImplementation = await deployContract('MockImplementation', 1)
    sigmaControllerImplementation = await deployContract('MockImplementation', 2)
    corePoolImplementation = await deployContract('MockImplementation', 3)
    recovery = await deployContract(
      'IndexPoolRecovery',
      coreControllerImplementation.address,
      sigmaControllerImplementation.address,
      corePoolImplementation.address,
      sigmaPoolImplementation,
      wallet.address
    );
    polygonRootChainManager = await getContract('0xA0c68C638235ee32657e8f720a23ceC1bFc77C77', 'IRootChainManager');
    polygonERC20Predicate = await getContract('0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf', 'ITokenPredicate')
    weth = await getContract('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 'IERC20')
    await sendEtherTo(treasury)
    const signer = await impersonate(treasury)
    recovery = recovery.connect(signer)
    await proxyManagerAccessControl.connect(signer).transferOwnership(recovery.address);
    reset = await createSnapshot()
  })

  const expectTransferFullBalanceToTreasury = async (from: string, tokens: string[], tx: Promise<ContractTransaction>) => {
    const { blockNumber } = await (await tx).wait()
    for (let tokenAddress of tokens) {
      const token = await getContract(tokenAddress, 'IERC20') as IERC20;
      const previousBalance = await token.balanceOf(from, { blockTag: blockNumber - 1 });
      expect(previousBalance).to.be.gt(0);
      await expect(tx).to.emit(token, 'Transfer').withArgs(from, treasury, previousBalance);
    }
  }

  beforeEach(async () => { await reset() })

  describe('set up', () => {
    it('Sets proxy implementation for core index, sigma index, core seller to recovery contract', async () => {
      await expect(recovery.drainAndRepair())
        .to.emit(proxyManager, 'ManyToOne_ImplementationUpdated')
        .withArgs(corePoolImplementationID, recovery.address)
        .to.emit(proxyManager, 'ManyToOne_ImplementationUpdated')
        .withArgs(sigmaPoolImplementationID, recovery.address)
        .to.emit(proxyManager, 'ManyToOne_ImplementationUpdated')
        .withArgs(coreSellerImplementationID, recovery.address)
    })
  })

  describe('defi5()', () => {
    it('Should revert if caller is not recovery contract', async () => {
      await expect(recovery.defi5()).to.be.reverted;
    })

    it('Should revert if recipient is not defi5', async () => {
      await sendEtherTo(recovery.address)
      await withSigner(recovery.address, async (signer) => {
        await proxyManagerAccessControl.connect(signer).setImplementationAddressManyToOne(corePoolImplementationID, recovery.address)
        await expect(recovery.connect(signer).defi5()).to.be.reverted;
      })
    })

    it('Should drain the token balances', async () => {
      await expectTransferFullBalanceToTreasury(defi5, defi5Tokens, recovery.drainAndRepair());
    })

    it('Should drain the ETH from the DEFI5-ETH pair on Uniswap', async () => {
      const pair = computeUniswapPairAddress(weth.address, defi5)
      const balance = await weth.balanceOf(pair);
      await expect(recovery.drainAndRepair())
        .to.emit(weth, 'Transfer')
        .withArgs(pair, treasury, balance.sub(1))
    })

    it('Should deposit to Polygon', async () => {
      await expect(recovery.drainAndRepair())
        .to.emit(polygonERC20Predicate, 'LockedERC20')
        .withArgs(recovery.address, wallet.address, defi5, sideChainDepositAmount)
    })
  })

  describe('cc10()', () => {
    it('Should revert if caller is not recovery contract', async () => {
      await expect(recovery.cc10()).to.be.reverted;
    })

    it('Should revert if recipient is not defi5', async () => {
      await sendEtherTo(recovery.address)
      await withSigner(recovery.address, async (signer) => {
        await proxyManagerAccessControl.connect(signer).setImplementationAddressManyToOne(corePoolImplementationID, recovery.address)
        await expect(recovery.connect(signer).cc10()).to.be.reverted;
      })
    })

    it('Should drain the token balances', async () => {
      await expectTransferFullBalanceToTreasury(cc10, cc10Tokens, recovery.drainAndRepair());
    })

    it('Should drain the ETH from the CC10-ETH pair on Uniswap', async () => {
      const pair = computeUniswapPairAddress(weth.address, cc10)
      const balance = await weth.balanceOf(pair);
      await expect(recovery.drainAndRepair())
        .to.emit(weth, 'Transfer')
        .withArgs(pair, treasury, balance.sub(1))
    })

    it('Should deposit to Polygon', async () => {
      await expect(recovery.drainAndRepair())
        .to.emit(polygonERC20Predicate, 'LockedERC20')
        .withArgs(recovery.address, wallet.address, cc10, sideChainDepositAmount)
    })
  })

  describe('transferFrom()', () => {
    it('Should revert if not called by erc20 predicate', async () => {
      await expect(recovery.transferFrom(recovery.address, polygonERC20Predicate.address, sideChainDepositAmount))
        .to.be.reverted;
    })

    it('Should revert if from is not recovery contract', async () => {
      await sendEtherTo(polygonERC20Predicate.address)
      await withSigner(polygonERC20Predicate.address, async (signer) => {
        await expect(
          recovery.connect(signer).transferFrom(
            wallet.address,
            polygonERC20Predicate.address,
            sideChainDepositAmount
          )
        ).to.be.reverted
      })
    })

    it('Should revert if to is not erc20 predicate', async () => {
      await sendEtherTo(polygonERC20Predicate.address)
      await withSigner(polygonERC20Predicate.address, async (signer) => {
        await expect(
          recovery.connect(signer).transferFrom(
            recovery.address,
            wallet.address,
            sideChainDepositAmount
          )
        ).to.be.reverted
      })
    })

    it('Should revert if amount is not max uint128', async () => {
      await sendEtherTo(polygonERC20Predicate.address)
      await withSigner(polygonERC20Predicate.address, async (signer) => {
        await expect(
          recovery.connect(signer).transferFrom(
            recovery.address,
            polygonERC20Predicate.address,
            1
          )
        ).to.be.reverted
      })
    })

    it('Should not revert if params and caller are correct', async () => {
      await sendEtherTo(polygonERC20Predicate.address)
      await withSigner(polygonERC20Predicate.address, async (signer) => {
        await expect(
          recovery.connect(signer).transferFrom(
            recovery.address,
            polygonERC20Predicate.address,
            sideChainDepositAmount
          )
        ).to.not.be.reverted
      })
    })
  })

  describe('fff()', () => {
    it('Should revert if caller is not recovery contract', async () => {
      await expect(recovery.fff()).to.be.reverted;
    })

    it('Should revert if recipient is not defi5', async () => {
      await sendEtherTo(recovery.address)
      await withSigner(recovery.address, async (signer) => {
        await proxyManagerAccessControl.connect(signer).setImplementationAddressManyToOne(corePoolImplementationID, recovery.address)
        await expect(recovery.connect(signer).fff()).to.be.reverted;
      })
    })

    it('Should drain the token balances', async () => {
      await expectTransferFullBalanceToTreasury(fff, fffTokens, recovery.drainAndRepair());
    })

    it('Should drain the ETH from the FFF-ETH pair on Uniswap', async () => {
      const pair = computeUniswapPairAddress(weth.address, fff)
      const balance = await weth.balanceOf(pair);
      await expect(recovery.drainAndRepair())
        .to.emit(weth, 'Transfer')
        .withArgs(pair, treasury, balance.sub(1))
    })

    it('Should deposit to Polygon', async () => {
      await expect(recovery.drainAndRepair())
        .to.emit(polygonERC20Predicate, 'LockedERC20')
        .withArgs(recovery.address, wallet.address, fff, sideChainDepositAmount)
    })
  })

  describe('cc10Seller()', () => {
    it('Should revert if caller is not recovery contract', async () => {
      await expect(recovery.cc10Seller()).to.be.reverted;
    })

    it('Should revert if recipient is not cc10Seller', async () => {
      await sendEtherTo(recovery.address)
      await withSigner(recovery.address, async (signer) => {
        await proxyManagerAccessControl.connect(signer).setImplementationAddressManyToOne(corePoolImplementationID, recovery.address)
        await expect(recovery.connect(signer).cc10Seller()).to.be.reverted;
      })
    })

    it('Should drain the token balances', async () => {
      await expectTransferFullBalanceToTreasury(cc10Seller, cc10SellerTokens, recovery.drainAndRepair());
    })
  })

  describe('clean up', () => {
    it('Upgrades the core and sigma pools and controllers', async () => {
      await expect(recovery.drainAndRepair())
      .to.emit(proxyManager, 'OneToOne_ImplementationUpdated')
      .withArgs(coreControllerAddress, coreControllerImplementation.address)
      .to.emit(proxyManager, 'OneToOne_ImplementationUpdated')
      .withArgs(sigmaControllerAddress, sigmaControllerImplementation.address)
      .to.emit(proxyManager, 'ManyToOne_ImplementationUpdated')
      .withArgs(corePoolImplementationID, corePoolImplementation.address)
      .to.emit(proxyManager, 'ManyToOne_ImplementationUpdated')
      .withArgs(sigmaPoolImplementationID, sigmaPoolImplementation)
      .to.emit(proxyManager, 'ManyToOne_ImplementationUpdated')
      .withArgs(coreSellerImplementationID, coreSellerImplementation)
    })
  })
});