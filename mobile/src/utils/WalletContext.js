/**
 * Hotpot — Wallet Context
 *
 * Provides Solana wallet connectivity via:
 *   - Mobile Wallet Adapter (MWA) for native Android (Phantom, Solflare)
 *   - Browser extension (window.solana) for web
 *
 * Exposes: walletAddress, connect, disconnect, sendASX, signMessage
 */

import { createContext, useState, useEffect, useContext } from 'react';
import { Connection, PublicKey, Transaction, TransactionInstruction, SystemProgram } from '@solana/web3.js';
import { transact } from '@solana-mobile/mobile-wallet-adapter-protocol-web3js';
import { Platform, Alert } from 'react-native';

// ── Constants ─────────────────────────────────────────────────────────────────

export const ASX_MINT   = 'cyaiYgJhfSuFY7yz8iNeBwsD1XNDzZXVBEGubuuxdma';
const HELIUS_KEY        = process.env.EXPO_PUBLIC_HELIUS_API_KEY;
export const SOLANA_RPC = HELIUS_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`
  : 'https://api.mainnet-beta.solana.com';

// ASX uses the Token-2022 (Token Extensions) program
const TOKEN_PROGRAM_ID            = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

const APP_IDENTITY = {
  name: 'Hotpot Network',
  uri:  'https://hotpot.assetux.com',
  icon: '/favicon.ico',
};

// ── ATA helpers ───────────────────────────────────────────────────────────────

async function findAssociatedTokenAddress(walletAddress, tokenMintAddress) {
  const [ata] = await PublicKey.findProgramAddress(
    [walletAddress.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), tokenMintAddress.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return ata;
}

function createAssociatedTokenAccountInstruction(payer, ata, owner, mint) {
  return new TransactionInstruction({
    keys: [
      { pubkey: payer,                          isSigner: true,  isWritable: true  },
      { pubkey: ata,                            isSigner: false, isWritable: true  },
      { pubkey: owner,                          isSigner: false, isWritable: false },
      { pubkey: mint,                           isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId,        isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID,               isSigner: false, isWritable: false },
    ],
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    data: Buffer.alloc(0),
  });
}

// ── Context ───────────────────────────────────────────────────────────────────

const WalletContext = createContext({
  publicKey:     null,
  walletAddress: null,
  balance:       0,
  connect:     async () => {},
  disconnect:  async () => {},
  sendASX:     async (_recipient, _amount) => {},
  signMessage: async (_message) => {},
});

export const WalletProvider = ({ children }) => {
  const [publicKey,  setPublicKey]  = useState(null);
  const [balance,    setBalance]    = useState(0);
  const [authToken,  setAuthToken]  = useState(null);

  // Refresh native SOL balance when the connected key changes
  useEffect(() => {
    if (!publicKey) { setBalance(0); return; }
    const connection = new Connection(SOLANA_RPC, 'confirmed');
    connection.getBalance(publicKey)
      .then(lamports => setBalance(lamports / 1e9))
      .catch(console.warn);
  }, [publicKey]);

  // ── connect ──────────────────────────────────────────────────────────────────

  const connect = async () => {
    // Web — browser extension (Phantom, Backpack, etc.)
    if (Platform.OS === 'web' && window.solana) {
      try {
        const resp = await window.solana.connect();
        setPublicKey(new PublicKey(resp.publicKey.toString()));
        return;
      } catch (e) {
        console.warn('[Wallet] Web extension connection failed:', e.message);
      }
    }

    // Native — Mobile Wallet Adapter
    try {
      await transact(async (wallet) => {
        const result = await wallet.authorize({
          cluster: 'mainnet-beta',
          identity: APP_IDENTITY,
        });
        const account = result.accounts[0];
        if (account) {
          setPublicKey(new PublicKey(Buffer.from(account.address, 'base64')));
          setAuthToken(result.auth_token);
        }
      });
    } catch (e) {
      if (e.message?.includes('Found no installed wallet')) {
        Alert.alert(
          'No Wallet Found',
          'Install Phantom or Solflare to connect your Solana wallet.',
          [{ text: 'OK' }]
        );
      } else {
        throw e;
      }
    }
  };

  // ── disconnect ────────────────────────────────────────────────────────────────

  const disconnect = async () => {
    setPublicKey(null);
    setBalance(0);
    setAuthToken(null);
  };

  // ── sendASX ───────────────────────────────────────────────────────────────────

  const sendASX = async (recipientAddress, amount) => {
    if (!publicKey) throw new Error('Wallet not connected');

    const connection = new Connection(SOLANA_RPC, 'confirmed');
    const recipient  = new PublicKey(recipientAddress);
    const mint       = new PublicKey(ASX_MINT);

    const sourceATA = await findAssociatedTokenAddress(publicKey, mint);
    const destATA   = await findAssociatedTokenAddress(recipient, mint);

    // Create destination ATA if it does not exist yet
    const destATAInfo = await connection.getAccountInfo(destATA);
    const createATAIx = destATAInfo === null
      ? createAssociatedTokenAccountInstruction(publicKey, destATA, recipient, mint)
      : null;

    // SPL Token-2022 TransferChecked instruction (index 12)
    const data = Buffer.alloc(10);
    data.writeUInt8(12, 0);
    data.writeBigUInt64LE(BigInt(Math.floor(amount * 1e9)), 1); // 9 decimals
    data.writeUInt8(9, 9);

    const transferIx = new TransactionInstruction({
      keys: [
        { pubkey: sourceATA, isSigner: false, isWritable: true  },
        { pubkey: mint,      isSigner: false, isWritable: false },
        { pubkey: destATA,   isSigner: false, isWritable: true  },
        { pubkey: publicKey, isSigner: true,  isWritable: false },
      ],
      programId: TOKEN_PROGRAM_ID,
      data,
    });

    // Web
    if (Platform.OS === 'web' && window.solana?.isPhantom) {
      const { blockhash } = await connection.getLatestBlockhash();
      const tx = new Transaction({ recentBlockhash: blockhash, feePayer: publicKey });
      if (createATAIx) tx.add(createATAIx);
      tx.add(transferIx);
      const { signature } = await window.solana.signAndSendTransaction(tx);
      return signature;
    }

    // Native MWA
    return await transact(async (wallet) => {
      const reauth = await wallet.reauthorize({ auth_token: authToken, identity: APP_IDENTITY });
      setAuthToken(reauth.auth_token ?? authToken);

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      const minContextSlot = await connection.getSlot();
      const tx = new Transaction({ recentBlockhash: blockhash, feePayer: publicKey });
      if (createATAIx) tx.add(createATAIx);
      tx.add(transferIx);

      const [sig] = await wallet.signAndSendTransactions({ transactions: [tx], minContextSlot });
      await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
      return sig;
    });
  };

  // ── signMessage ───────────────────────────────────────────────────────────────

  /**
   * Signs an arbitrary message with the connected wallet.
   * Returns { signature: '0x…', pubKey: '0x…' }
   */
  const signMessage = async (message) => {
    if (!publicKey) throw new Error('Wallet not connected');

    return await transact(async (wallet) => {
      // Reauthorize with cached token; fall back to fresh authorize if expired
      let token = authToken;
      if (token) {
        try {
          const reauth = await wallet.reauthorize({ auth_token: token, identity: APP_IDENTITY });
          token = reauth.auth_token ?? token;
        } catch {
          const auth = await wallet.authorize({ cluster: 'mainnet-beta', identity: APP_IDENTITY });
          token = auth.auth_token;
        }
      } else {
        const auth = await wallet.authorize({ cluster: 'mainnet-beta', identity: APP_IDENTITY });
        token = auth.auth_token;
      }
      setAuthToken(token);

      const msgBytes  = typeof message === 'string' ? new TextEncoder().encode(message) : message;
      // Pass the signing address explicitly so Phantom routes to the correct account
      const addrB64   = Buffer.from(publicKey.toBytes()).toString('base64');
      const [signed]  = await wallet.signMessages({ payloads: [msgBytes], addresses: [addrB64] });

      return {
        signature: Buffer.from(signed).toString('hex'),
        pubKey:    publicKey.toBase58(),
      };
    });
  };

  // ─────────────────────────────────────────────────────────────────────────────

  const walletAddress = publicKey?.toBase58() ?? null;

  return (
    <WalletContext.Provider value={{ publicKey, walletAddress, balance, connect, disconnect, sendASX, signMessage }}>
      {children}
    </WalletContext.Provider>
  );
};

export const useWallet = () => useContext(WalletContext);
