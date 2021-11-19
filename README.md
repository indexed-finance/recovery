# indexed-recovery-contract

This contains a smart contract that will:
1. Change the proxy implementation for the core and sigma pools and the core UnboundTokenSeller contract to the recovery contract.
2. Drain the remaining assets from DEFI5, CC10, the CC10 UnboundTokenSeller and FFF to the Indexed treasury.
3. Drain the ETH from the DEFI5-ETH, CC10-ETH and FFF-ETH Uniswap pairs to the Indexed treasury.
4. Execute fake deposits of 2**128-1 of DEFI5, CC10 and FFF to Polygon.
   - These deposits will be received by a gnosis safe owned by the core team and used to drain the assets in the DEFI5, CC10 and FFF market pairs on Polygon, which will be sent to the treasury.
5. Destroy DEFI5, CC10 and FFF.
6. Upgrade the proxies for the core and sigma pools and controllers in order to remove the exploited vulnerability.
7. Set the core UnboundTokenSeller implementation back to what it currently is.
8. Transfer ownership of the proxy manager's access control back to the treasury.


## Scripts

`yarn test`

Runs all tests in `test/`

`yarn coverage`

Runs all tests with solidity-coverage and generates a coverage report.

`yarn compile`

Compiles artifacts into `artifacts/` and generates typechain interfaces in `typechain/`

`yarn lint`

Runs solhint against the contracts.