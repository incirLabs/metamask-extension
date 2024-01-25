import { InternalAccount } from '@metamask/keyring-api';
import { KeyringController } from '@metamask/keyring-controller';
import {
  TransactionController,
  TransactionMeta,
  TransactionParams,
} from '@metamask/transaction-controller';
import {
  AddUserOperationOptions,
  PrepareUserOperationRequest,
  PrepareUserOperationResponse,
  SignUserOperationRequest,
  SignUserOperationResponse,
  UpdateUserOperationRequest,
  UpdateUserOperationResponse,
  UserOperationController,
} from '@metamask/user-operation-controller';

export type AddTransactionOptions = NonNullable<
  Parameters<TransactionController['addTransaction']>[1]
>;

type BaseAddTransactionRequest = {
  networkClientId: string;
  selectedAccount: InternalAccount;
  transactionParams: TransactionParams;
  transactionController: TransactionController;
  userOperationController: UserOperationController;
  keyringController: KeyringController;
};

type FinalAddTransactionRequest = BaseAddTransactionRequest & {
  transactionOptions: AddTransactionOptions;
};

export type AddTransactionRequest = FinalAddTransactionRequest & {
  waitForSubmit: boolean;
};

export type AddDappTransactionRequest = BaseAddTransactionRequest & {
  dappRequest: Record<string, any>;
};

export async function addDappTransaction(
  request: AddDappTransactionRequest,
): Promise<string> {
  const { dappRequest } = request;
  const { id: actionId, method, origin } = dappRequest;

  ///: BEGIN:ONLY_INCLUDE_IF(blockaid)
  const { securityAlertResponse } = dappRequest;
  ///: END:ONLY_INCLUDE_IF

  const transactionOptions: AddTransactionOptions = {
    actionId,
    method,
    origin,
    // This is the default behaviour but specified here for clarity
    requireApproval: true,
    ///: BEGIN:ONLY_INCLUDE_IF(blockaid)
    securityAlertResponse,
    ///: END:ONLY_INCLUDE_IF
  };

  const { waitForHash } = await addTransactionOrUserOperation({
    ...request,
    transactionOptions,
  });

  return (await waitForHash()) as string;
}

export async function addTransaction(
  request: AddTransactionRequest,
): Promise<TransactionMeta> {
  const { waitForSubmit } = request;

  const { transactionMeta, waitForHash } = await addTransactionOrUserOperation(
    request,
  );

  if (!waitForSubmit) {
    waitForHash().catch(() => {
      // Not concerned with result.
    });

    return transactionMeta as TransactionMeta;
  }

  const transactionHash = await waitForHash();

  const finalTransactionMeta = getTransactionByHash(
    transactionHash as string,
    request.transactionController,
  );

  return finalTransactionMeta as TransactionMeta;
}

async function addTransactionOrUserOperation(
  request: FinalAddTransactionRequest,
) {
  const { selectedAccount } = request;

  const isSmartContractAccount = selectedAccount.type === 'eip155:erc4337';

  if (isSmartContractAccount) {
    return addUserOperationWithController(request);
  }

  return addTransactionWithController(request);
}

async function addTransactionWithController(
  request: FinalAddTransactionRequest,
) {
  const { transactionController, transactionOptions, transactionParams } =
    request;

  const { result, transactionMeta } =
    await transactionController.addTransaction(
      transactionParams,
      transactionOptions,
    );

  return {
    transactionMeta,
    waitForHash: () => result,
  };
}

async function addUserOperationWithController(
  request: FinalAddTransactionRequest,
) {
  const {
    networkClientId,
    transactionController,
    transactionOptions,
    transactionParams,
    userOperationController,
    selectedAccount,
    keyringController,
  } = request;

  const { origin, type } = transactionOptions as any;

  const normalisedTransaction: TransactionParams = {
    ...transactionParams,
    maxFeePerGas: '0x0',
    maxPriorityFeePerGas: '0x0',
  };

  const swaps = transactionOptions?.swaps?.meta;

  if (swaps?.type) {
    delete swaps.type;
  }

  const options: AddUserOperationOptions = {
    networkClientId,
    origin,
    requireApproval: true,
    swaps,
    type,
    smartContractAccount: {
      prepareUserOperation: async (
        _request: PrepareUserOperationRequest,
      ): Promise<PrepareUserOperationResponse> => {
        console.log('Prepare request', _request);

        const userOp = await keyringController.prepareUserOperation(
          selectedAccount.address,
          [
            {
              to: _request.to ?? '0x',
              data: _request.data ?? '0x',
              value: _request.value ?? '0x',
            },
          ],
        );

        const newUserOp: any = {
          ...userOp,
          gas: userOp.gasLimits,
          bundler: userOp.bundlerUrl,
          sender: selectedAccount.address,
        };

        delete newUserOp.gasLimits;
        delete newUserOp.bundlerUrl;

        return newUserOp;
      },

      updateUserOperation: async (
        _request: UpdateUserOperationRequest,
      ): Promise<UpdateUserOperationResponse> => {
        console.log('Patch request', _request);

        return keyringController.patchUserOperation(
          selectedAccount.address,
          _request.userOperation,
        );
      },

      signUserOperation: async (
        _request: SignUserOperationRequest,
      ): Promise<SignUserOperationResponse> => {
        console.log('Sign request', _request);

        const ret = {
          signature: await keyringController.signUserOperation(
            selectedAccount.address,
            _request.userOperation,
          ),
        };

        console.log('sign req user op', ret);

        return ret;
      },
    },
  } as any;

  const result = await userOperationController.addUserOperationFromTransaction(
    normalisedTransaction,
    options,
  );

  userOperationController.startPollingByNetworkClientId(networkClientId);

  const transactionMeta = getTransactionById(result.id, transactionController);

  return {
    transactionMeta,
    waitForHash: result.transactionHash,
  };
}

function getTransactionById(
  transactionId: string,
  transactionController: TransactionController,
) {
  return transactionController.state.transactions.find(
    (tx) => tx.id === transactionId,
  );
}

function getTransactionByHash(
  transactionHash: string,
  transactionController: TransactionController,
) {
  return transactionController.state.transactions.find(
    (tx) => tx.hash === transactionHash,
  );
}
