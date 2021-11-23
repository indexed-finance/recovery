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
  let corePoolImplementation = '0x669693A42B58E87b9e568bA2C6AdD607eb298d95';
  const coreSellerImplementation = '0x2F0869D7AFd6638d2c83Fb2bfD79d5956D0cB952';
  const sigmaPoolImplementation = '0x7B3B2B39CbdBddaDC13D8559D82c054b9C2fd5f3';
  const sideChainDepositAmount = BigNumber.from(2).pow(128).sub(1);
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
    const { gasUsed } = await recovery.deployTransaction.wait()
    console.log(`IndexPoolRecovery Gas Cost: ${gasUsed.toNumber()}`)
    polygonRootChainManager = await getContract('0xA0c68C638235ee32657e8f720a23ceC1bFc77C77', 'IRootChainManager');
    polygonERC20Predicate = await getContract('0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf', 'ITokenPredicate')
    weth = await getContract('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 'IERC20')
    await sendEtherTo(treasury)
    await sendEtherTo(recovery.address)
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
  })

  describe('assumptions', () => {
    it('Destroys only affected pools', async () => {
      await recovery.drainAndRepair()
      const codeAffected = await Promise.all(affectedPools.map(pool => ethers.provider.getCode(pool)));
      const codeUnaffected = await Promise.all(unaffectedPools.map(pool => ethers.provider.getCode(pool)));
      expect(codeAffected).to.deep.eq(['0x', '0x', '0x']);
      expect(codeUnaffected).to.not.deep.eq(['0x', '0x', '0x']);
    });

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