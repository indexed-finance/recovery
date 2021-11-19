// SPDX-License-Identifier: MIT
pragma solidity >=0.5.0;

/// @title Token predicate interface for all pos portal predicates
/// @notice Abstract interface that defines methods for custom predicates
interface ITokenPredicate {
  event LockedERC20(
    address indexed depositor,
    address indexed depositReceiver,
    address indexed rootToken,
    uint256 amount
  );

  /**
   * @notice Deposit tokens into pos portal
   * @dev When `depositor` deposits tokens into pos portal, tokens get locked into predicate contract.
   * @param depositor Address who wants to deposit tokens
   * @param depositReceiver Address (address) who wants to receive tokens on side chain
   * @param rootToken Token which gets deposited
   * @param depositData Extra data for deposit (amount for ERC20, token id for ERC721 etc.) [ABI encoded]
   */
  function lockTokens(
    address depositor,
    address depositReceiver,
    address rootToken,
    bytes calldata depositData
  ) external;

  /**
   * @notice Validates and processes exit while withdraw process
   * @dev Validates exit log emitted on sidechain. Reverts if validation fails.
   * @dev Processes withdraw based on custom logic. Example: transfer ERC20/ERC721, mint ERC721 if mintable withdraw
   * @param sender Address
   * @param rootToken Token which gets withdrawn
   * @param logRLPList Valid sidechain log for data like amount, token id etc.
   */
  function exitTokens(
    address sender,
    address rootToken,
    bytes calldata logRLPList
  ) external;
}
