// SPDX-License-Identifier: MIT
pragma solidity =0.7.6;


contract MockImplementation {
  uint256 public immutable implementationID;
  
  constructor(uint256 _implementationID) {
    implementationID = _implementationID;
  }
}