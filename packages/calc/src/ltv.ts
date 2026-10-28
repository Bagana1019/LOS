// FR-14.2, FR-14.4
export const collateralValue = (marketValue: number, haircut: number) => Math.round(marketValue * haircut * 100) / 100;
export const ltv = (loanAmount: number, totalCollateralValue: number) => totalCollateralValue <= 0 ? Infinity : loanAmount / totalCollateralValue;
