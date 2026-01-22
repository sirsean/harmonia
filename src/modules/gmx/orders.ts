import { ethers } from "ethers";
import {
  GMXDecreaseOrderRequest,
  GMXDecreasePositionSwapType,
  GMXIncreaseOrderRequest,
  GMXOrderExecutionConfig,
  GMXOrderExecutionResult,
  GMXOrderParams,
  GMXOrderType,
  GMXRouter,
  IERC20,
} from "./types";

export const GMX_ROUTER_ABI = [
  "function multicall(bytes[] calldata data) external payable returns (bytes[] memory results)",
  "function sendTokens(address token, address receiver, uint256 amount) external payable",
  "function sendWnt(address receiver, uint256 amount) external payable",
  "function createOrder(((address receiver,address cancellationReceiver,address callbackContract,address uiFeeReceiver,address market,address initialCollateralToken,address[] swapPath),(uint256 sizeDeltaUsd,uint256 initialCollateralDeltaAmount,uint256 triggerPrice,uint256 acceptablePrice,uint256 executionFee,uint256 callbackGasLimit,uint256 minOutputAmount,uint256 validFromTime),uint8 orderType,uint8 decreasePositionSwapType,bool isLong,bool shouldUnwrapNativeToken,bool autoCancel,bytes32 referralCode,bytes32[] dataList) params) external payable returns (bytes32 orderKey)",
];

export function createRouter(address: string, signer: ethers.Signer): GMXRouter {
  return new ethers.Contract(address, GMX_ROUTER_ABI, signer) as unknown as GMXRouter;
}

export function buildIncreaseOrderParams(request: GMXIncreaseOrderRequest): GMXOrderParams {
  return [
    {
      receiver: request.account,
      cancellationReceiver: request.account,
      callbackContract: request.callbackContract ?? ethers.ZeroAddress,
      uiFeeReceiver: request.uiFeeReceiver ?? ethers.ZeroAddress,
      market: request.market,
      initialCollateralToken: request.collateralToken,
      swapPath: request.swapPath ?? [],
    },
    {
      sizeDeltaUsd: request.sizeDeltaUsd,
      initialCollateralDeltaAmount: request.collateralAmount,
      triggerPrice: 0n,
      acceptablePrice: request.acceptablePrice,
      executionFee: request.executionFee,
      callbackGasLimit: 0n,
      minOutputAmount: 0n,
      validFromTime: 0n,
    },
    request.orderType ?? GMXOrderType.MarketIncrease,
    GMXDecreasePositionSwapType.NoSwap,
    request.isLong ?? false,
    request.shouldUnwrapNativeToken ?? false,
    request.autoCancel ?? false,
    request.referralCode ?? ethers.ZeroHash,
    request.dataList ?? [],
  ];
}

export function buildDecreaseOrderParams(request: GMXDecreaseOrderRequest): GMXOrderParams {
  return [
    {
      receiver: request.account,
      cancellationReceiver: request.account,
      callbackContract: request.callbackContract ?? ethers.ZeroAddress,
      uiFeeReceiver: request.uiFeeReceiver ?? ethers.ZeroAddress,
      market: request.market,
      initialCollateralToken: request.collateralToken,
      swapPath: request.swapPath ?? [],
    },
    {
      sizeDeltaUsd: request.sizeDeltaUsd,
      initialCollateralDeltaAmount: 0n,
      triggerPrice: 0n,
      acceptablePrice: request.acceptablePrice,
      executionFee: request.executionFee,
      callbackGasLimit: 0n,
      minOutputAmount: 0n,
      validFromTime: 0n,
    },
    request.orderType ?? GMXOrderType.MarketDecrease,
    GMXDecreasePositionSwapType.NoSwap,
    request.isLong ?? false,
    request.shouldUnwrapNativeToken ?? false,
    request.autoCancel ?? false,
    request.referralCode ?? ethers.ZeroHash,
    request.dataList ?? [],
  ];
}

export function buildMulticallData(
  routerInterface: GMXRouter["interface"],
  config: {
    orderVault: string;
    orderParams: GMXOrderParams;
    collateralToken?: string;
    collateralAmount?: bigint;
    executionFee: bigint;
  }
): string[] {
  const data: string[] = [];

  data.push(
    routerInterface.encodeFunctionData("sendWnt", [config.orderVault, config.executionFee])
  );

  if (config.collateralToken && config.collateralAmount && config.collateralAmount > 0n) {
    data.push(
      routerInterface.encodeFunctionData("sendTokens", [
        config.collateralToken,
        config.orderVault,
        config.collateralAmount,
      ])
    );
  }

  data.push(routerInterface.encodeFunctionData("createOrder", [config.orderParams]));

  return data;
}

export async function ensureAllowance(
  token: IERC20,
  owner: string,
  spender: string,
  amount: bigint
): Promise<boolean> {
  const allowance = await token.allowance(owner, spender);
  if (allowance >= amount) {
    return false;
  }
  const approval = await token.approve(spender, amount);
  await approval.wait();
  return true;
}

async function maybeStaticCall(
  router: GMXRouter,
  data: string[],
  executionFee: bigint,
  performStaticCall: boolean
): Promise<void> {
  const staticCall = router.multicall?.staticCall;
  if (!performStaticCall || !staticCall) {
    return;
  }
  await staticCall(data, { value: executionFee });
}

export async function createIncreaseOrder(
  router: GMXRouter,
  token: IERC20,
  request: GMXIncreaseOrderRequest,
  config: GMXOrderExecutionConfig
): Promise<GMXOrderExecutionResult> {
  const orderParams = buildIncreaseOrderParams(request);

  const routerAddress = config.routerAddress ?? routerAddressFromInterface(router);
  await ensureAllowance(token, request.account, routerAddress, request.collateralAmount);

  const multicallData = buildMulticallData(router.interface, {
    orderVault: config.orderVault,
    orderParams,
    collateralToken: request.collateralToken,
    collateralAmount: request.collateralAmount,
    executionFee: request.executionFee,
  });

  const performStaticCall = config.performStaticCall ?? true;
  await maybeStaticCall(router, multicallData, request.executionFee, performStaticCall);

  const tx = await router.multicall(multicallData, {
    value: request.executionFee,
    gasLimit: config.gasLimit,
    nonce: config.nonce,
  });

  return {
    orderParams,
    multicallData,
    txHash: tx.hash,
  };
}

export async function createDecreaseOrder(
  router: GMXRouter,
  request: GMXDecreaseOrderRequest,
  config: GMXOrderExecutionConfig
): Promise<GMXOrderExecutionResult> {
  const orderParams = buildDecreaseOrderParams(request);

  const multicallData = buildMulticallData(router.interface, {
    orderVault: config.orderVault,
    orderParams,
    executionFee: request.executionFee,
  });

  const performStaticCall = config.performStaticCall ?? true;
  await maybeStaticCall(router, multicallData, request.executionFee, performStaticCall);

  const tx = await router.multicall(multicallData, {
    value: request.executionFee,
    gasLimit: config.gasLimit,
    nonce: config.nonce,
  });

  return {
    orderParams,
    multicallData,
    txHash: tx.hash,
  };
}

function routerAddressFromInterface(router: GMXRouter): string {
  const address = (router as unknown as { target?: string }).target;
  if (!address) {
    throw new Error("Router address not available on contract instance.");
  }
  return address;
}
