import { ethers, waffle } from 'hardhat';
import { expect } from "chai";
import {
  IDelegateCallProxyManager,
  IndexPoolRecovery,
  MockImplementation,
  IRootChainManager,
  ITokenPredicate,
  IERC20,
  IProxyManagerAccessControl,
  IIndexPool
} from '../typechain';
import { computeUniswapPairAddress, createSnapshot, deployContract, getContract, impersonate, sendEtherTo, withSigner } from './shared';
import { ContractTransaction } from '@ethersproject/contracts';
import { JsonRpcSigner } from '@ethersproject/providers'
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

const affectedPools = [
  defi5,
  cc10,
  fff
];

const unaffectedPools = [
  '0x126c121f99e1e211df2e5f8de2d96fa36647c855',
  '0xd6cb2adf47655b1babddc214d79257348cbc39a7',
  '0x68bb81b3f67f7aab5fd1390ecb0b8e1a806f2465',
];


describe("IndexPoolRecovery", function() {
  const [wallet, wallet1] = waffle.provider.getWallets()
  let proxyManagerAccessControl: IProxyManagerAccessControl
  let proxyManager: IDelegateCallProxyManager
  let recovery: IndexPoolRecovery
  let polygonRootChainManager: IRootChainManager;
  let polygonERC20Predicate: ITokenPredicate;
  let coreControllerImplementation = '0x78b4f45B4A2Afa333C7Be1dbc7F2c9F056615327';
  let sigmaControllerImplementation = '0x4561784841DE5335922a9ad3E44aba69a162bA7A';
  let corePoolImplementation: string;
  let sigmaPoolImplementation: string;
  // let corePoolImplementation = '0x669693A42B58E87b9e568bA2C6AdD607eb298d95';
  const coreSellerImplementation = '0x2F0869D7AFd6638d2c83Fb2bfD79d5956D0cB952';
  // const sigmaPoolImplementation = '0x7B3B2B39CbdBddaDC13D8559D82c054b9C2fd5f3';
  const sideChainDepositAmount = BigNumber.from(2).pow(128).sub(1);
  let treasurySigner: JsonRpcSigner
  let weth: IERC20;
  let reset: () => Promise<void>

  let unaffectedPoolTokens: { address: string; balance: BigNumber; }[][] = []

  before(async () => {
    unaffectedPoolTokens = await Promise.all(unaffectedPools.map(async (pool) => {
      const index: IIndexPool = await getContract(pool, 'IIndexPool');
      const tokens = await index.getCurrentTokens();
      return Promise.all(tokens.map(async (token) => {
        const erc: IERC20 = await getContract(token, 'IERC20');
        return {
          address: token,
          balance: await erc.balanceOf(pool)
        }
      }))
    }));
    const coreFallThrough = await deployContract('CoreFallThrough');
    const sigmaFallThrough = await deployContract('SigmaFallThrough');
    corePoolImplementation = coreFallThrough.address;
    sigmaPoolImplementation = sigmaFallThrough.address;
    proxyManager = await getContract('0xD23DeDC599bD56767e42D48484d6Ca96ab01C115', 'IDelegateCallProxyManager')
    proxyManagerAccessControl = await getContract('0x3D4860d4b7952A3CAD3Accfada61463F15fc0D54', 'IProxyManagerAccessControl')
    recovery = await deployContract(
      'IndexPoolRecovery',
      coreControllerImplementation,
      sigmaControllerImplementation,
      corePoolImplementation,
      sigmaPoolImplementation,
      wallet.address
    );
    const { gasUsed: g1 } = await recovery.deployTransaction.wait()
    const { gasUsed: g2 } = await coreFallThrough.deployTransaction.wait()
    const { gasUsed: g3 } = await sigmaFallThrough.deployTransaction.wait()
    console.log(`IndexPoolRecovery Gas Cost: ${g1.toNumber()}`)
    console.log(`CoreFallThrough Gas Cost: ${g2.toNumber()}`)
    console.log(`SigmaFallThrough Gas Cost: ${g3.toNumber()}`)
    polygonRootChainManager = await getContract('0xA0c68C638235ee32657e8f720a23ceC1bFc77C77', 'IRootChainManager');
    polygonERC20Predicate = await getContract('0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf', 'ITokenPredicate')
    weth = await getContract('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 'IERC20')
    await sendEtherTo(treasury)
    await sendEtherTo(recovery.address)
    treasurySigner = await impersonate(treasury)
    recovery = recovery.connect(treasurySigner)
    await proxyManagerAccessControl.connect(treasurySigner).transferOwnership(recovery.address);
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
    it('Should revert if contract is not defi5, fff or cc10', async () => {
      await withSigner(polygonERC20Predicate.address, async (signer) => {
        await expect(
          recovery.connect(signer).transferFrom(
            recovery.address,
            polygonERC20Predicate.address,
            sideChainDepositAmount
          )
        ).to.be.reverted
      })
    })

    it('Should revert if not called by erc20 predicate', async () => {
      await withSigner(recovery.address, async (signer) => {
        await proxyManagerAccessControl.connect(signer).setImplementationAddressManyToOne(corePoolImplementationID, recovery.address)
      })
      const contract: IndexPoolRecovery = await getContract(defi5, 'IndexPoolRecovery')
      await expect(contract.transferFrom(recovery.address, polygonERC20Predicate.address, sideChainDepositAmount))
        .to.be.reverted;
    })

    it('Should revert if from is not recovery contract', async () => {
      await withSigner(recovery.address, async (signer) => {
        await proxyManagerAccessControl.connect(signer).setImplementationAddressManyToOne(corePoolImplementationID, recovery.address)
      })
      const contract: IndexPoolRecovery = await getContract(defi5, 'IndexPoolRecovery')
      await sendEtherTo(polygonERC20Predicate.address)
      await withSigner(polygonERC20Predicate.address, async (signer) => {
        await expect(
          contract.connect(signer).transferFrom(
            wallet.address,
            polygonERC20Predicate.address,
            sideChainDepositAmount
          )
        ).to.be.reverted
      })
    })

    it('Should revert if to is not erc20 predicate', async () => {
      await withSigner(recovery.address, async (signer) => {
        await proxyManagerAccessControl.connect(signer).setImplementationAddressManyToOne(corePoolImplementationID, recovery.address)
      })
      const contract: IndexPoolRecovery = await getContract(defi5, 'IndexPoolRecovery')
      await sendEtherTo(polygonERC20Predicate.address)
      await withSigner(polygonERC20Predicate.address, async (signer) => {
        await expect(
          contract.connect(signer).transferFrom(
            recovery.address,
            wallet.address,
            sideChainDepositAmount
          )
        ).to.be.reverted
      })
    })

    it('Should revert if amount is not max uint128', async () => {
      await withSigner(recovery.address, async (signer) => {
        await proxyManagerAccessControl.connect(signer).setImplementationAddressManyToOne(corePoolImplementationID, recovery.address)
      })
      const contract: IndexPoolRecovery = await getContract(defi5, 'IndexPoolRecovery')
      await sendEtherTo(polygonERC20Predicate.address)
      await withSigner(polygonERC20Predicate.address, async (signer) => {
        await expect(
          contract.connect(signer).transferFrom(
            recovery.address,
            polygonERC20Predicate.address,
            1
          )
        ).to.be.reverted
      })
    })

    it('Should not revert if params and caller are correct', async () => {
      await withSigner(recovery.address, async (signer) => {
        await proxyManagerAccessControl.connect(signer).setImplementationAddressManyToOne(corePoolImplementationID, recovery.address)
      })
      const contract: IndexPoolRecovery = await getContract(defi5, 'IndexPoolRecovery')
      await sendEtherTo(polygonERC20Predicate.address)
      await withSigner(polygonERC20Predicate.address, async (signer) => {
        await expect(
          contract.connect(signer).transferFrom(
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
      .withArgs(coreControllerAddress, coreControllerImplementation)
      .to.emit(proxyManager, 'OneToOne_ImplementationUpdated')
      .withArgs(sigmaControllerAddress, sigmaControllerImplementation)
      .to.emit(proxyManager, 'ManyToOne_ImplementationUpdated')
      .withArgs(corePoolImplementationID, corePoolImplementation)
      .to.emit(proxyManager, 'ManyToOne_ImplementationUpdated')
      .withArgs(sigmaPoolImplementationID, sigmaPoolImplementation)
      .to.emit(proxyManager, 'ManyToOne_ImplementationUpdated')
      .withArgs(coreSellerImplementationID, coreSellerImplementation)
    })

    it('DEFI5 and CC10 can still access balanceOf', async () => {
      const DEFI5 = await getContract(defi5, 'IERC20') as IERC20;
      const CC10 = await getContract(cc10, 'IERC20') as IERC20;
      const oldBalanceDEFI5 = await DEFI5.balanceOf(treasury)
      const oldBalanceCC10 = await CC10.balanceOf(treasury)
      expect(oldBalanceDEFI5).to.be.gt(0)
      expect(oldBalanceCC10).to.be.gt(0)
      await recovery.drainAndRepair()
      expect(await DEFI5.balanceOf(treasury)).to.eq(oldBalanceDEFI5)
      expect(await CC10.balanceOf(treasury)).to.eq(oldBalanceCC10)
    })

    it('DEFI5 and CC10 revert on other calls', async () => {
      const DEFI5 = await getContract(defi5, 'IERC20') as IERC20;
      const CC10 = await getContract(cc10, 'IERC20') as IERC20;
      const oldBalanceDEFI5 = await DEFI5.balanceOf(treasury)
      const oldBalanceCC10 = await CC10.balanceOf(treasury)
      await recovery.drainAndRepair()
      await expect(
        DEFI5.connect(treasurySigner).transfer(wallet.address, oldBalanceDEFI5)
      ).to.be.revertedWith('Contract disabled')
      await expect(
        CC10.connect(treasurySigner).transfer(wallet.address, oldBalanceCC10)
      ).to.be.revertedWith('Contract disabled')
    })

    it('ORCL5 functions normally', async () => {
      const ORCL5 = await getContract('0xD6cb2aDF47655B1bABdDc214d79257348CBC39A7', 'IERC20') as IERC20;
      const oldBalanceORCL5 = await ORCL5.balanceOf(treasury);
      await recovery.drainAndRepair();
      await expect(ORCL5.connect(treasurySigner).transfer(wallet.address, oldBalanceORCL5))
        .to.emit(ORCL5, 'Transfer')
        .withArgs(treasury, wallet.address, oldBalanceORCL5)
    })

    it('FFF can still access balanceOf', async () => {
      const FFF = await getContract(fff, 'IERC20') as IERC20;
      const oldBalanceFFF = await FFF.balanceOf(treasury)
      expect(oldBalanceFFF).to.be.gt(0)
      await recovery.drainAndRepair()
      expect(await FFF.balanceOf(treasury)).to.eq(oldBalanceFFF)
    })

    it('FFF reverts on other calls', async () => {
      const FFF = await getContract(fff, 'IERC20') as IERC20;
      const oldBalanceFFF = await FFF.balanceOf(treasury)
      await recovery.drainAndRepair()
      await expect(
        FFF.connect(treasurySigner).transfer(wallet.address, oldBalanceFFF)
      ).to.be.revertedWith('Contract disabled')
    })

    it('DEGEN functions normally', async () => {
      const DEGEN = await getContract('0x126c121f99e1e211df2e5f8de2d96fa36647c855', 'IERC20') as IERC20;
      const oldBalanceDEGEN = await DEGEN.balanceOf(treasury);
      expect(oldBalanceDEGEN).to.be.gt(0)
      await recovery.drainAndRepair();
      await expect(DEGEN.connect(treasurySigner).transfer(wallet.address, oldBalanceDEGEN))
        .to.emit(DEGEN, 'Transfer')
        .withArgs(treasury, wallet.address, oldBalanceDEGEN)
    })

    it('NFTP functions normally', async () => {
      const NFTP = await getContract('0x68bb81b3f67f7aab5fd1390ecb0b8e1a806f2465', 'IERC20') as IERC20;
      const oldBalancNFTP = await NFTP.balanceOf(treasury);
      await recovery.drainAndRepair();
      await expect(NFTP.connect(treasurySigner).transfer(wallet.address, oldBalancNFTP))
        .to.emit(NFTP, 'Transfer')
        .withArgs(treasury, wallet.address, oldBalancNFTP)
    })
  })

  describe('assumptions', () => {
    it('Transfers no tokens in unaffected pools', async () => {
      await recovery.drainAndRepair()
      for (let i = 0; i < 3; i++) {
        const pool = unaffectedPools[i]
        const tokens = unaffectedPoolTokens[i]
        for (const token of tokens) {
          const erc: IERC20 = await getContract(token.address, 'IERC20')
          expect(await erc.balanceOf(pool)).to.eq(token.balance)
        }
      }
    })
  })
});