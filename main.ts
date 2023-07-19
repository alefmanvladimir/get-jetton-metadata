import {getHttpEndpoint} from "@orbs-network/ton-access";
import {Address, Slice, TonClient, TupleReader, TupleItemCell, TupleItemInt} from "ton";
import {Sha256} from "@aws-crypto/sha256-js";
import axios from "axios";
import {parseDict} from "ton-core/dist/dict/parseDict";
import {bitsToPaddedBuffer} from "ton-core/dist/boc/utils/paddedBits";


type persistenceType = "onchain" | "offchain_private_domain" | "offchain_ipfs";

type JettonMetaDataKeys =
    | "name"
    | "description"
    | "image"
    | "symbol"
    | "image_data"
    | "decimals";

const jettonOnChainMetadataSpec: {
    [key in JettonMetaDataKeys]: "utf8" | "ascii" | undefined;
} = {
    name: "utf8",
    description: "utf8",
    image: "ascii",
    decimals: "utf8",
    symbol: "utf8",
    image_data: undefined,
};

const ONCHAIN_CONTENT_PREFIX = 0x00;
const OFFCHAIN_CONTENT_PREFIX = 0x01;
const SNAKE_PREFIX = 0x00;

const sha256 = (str: string) => {
    const sha = new Sha256();
    sha.update(str);
    return Buffer.from(sha.digestSync());
};

async function readContent(res: { gas_used: number; stack: TupleReader }) : Promise<{
    persistenceType: persistenceType;
    metadata: { [s in JettonMetaDataKeys]?: string };
    isJettonDeployerFaultyOnChainData?: boolean;
}> {
    const contentCell = res.stack.readCell()
    const contentSlice = contentCell.beginParse()

    switch (contentSlice.loadUint(8)) {
        case ONCHAIN_CONTENT_PREFIX:
            return {
                persistenceType: "onchain",
                ...parseJettonOnchainMetadata(contentSlice),
            };
        case OFFCHAIN_CONTENT_PREFIX:
            const {metadata, isIpfs} = await parseJettonOffchainMetadata(contentSlice);
            return {
                persistenceType: isIpfs ? "offchain_ipfs" : "offchain_private_domain",
                metadata,
            };
        default:
            throw new Error("Unexpected jetton metadata content prefix");
    }
}

async function readJettonWalletMedata(client: TonClient, address: string){
    const walletData = await client.runMethod(Address.parse(address), "get_wallet_data")
    walletData.stack.skip(2)
    return readJettonMetadata(client, walletData.stack.readAddress().toString())
}

async function readNftItemMetadata(client: TonClient, address: string)  {
    const nftItemAddress = Address.parse(address);
    const nftData = await client.runMethod(nftItemAddress, "get_nft_data")
    nftData.stack.skip(1)
    const index = nftData.stack.readBigNumber()
    const collection_address = nftData.stack.readAddress()
    nftData.stack.skip(1)
    const individual_item_content = nftData.stack.readCell()

    const arg1: TupleItemInt = {
        type: "int",
        value: index
    }

    const arg2: TupleItemCell = {
        type: "cell",
        cell: individual_item_content
    }

    const nftCollectionContent = await client.runMethod(collection_address, "get_nft_content", [arg1, arg2])

    let linkSlice = nftCollectionContent.stack.readCell().beginParse()

    const pathBase = bitsToPaddedBuffer(linkSlice.loadBits(linkSlice.remainingBits)).toString()

    linkSlice = individual_item_content.beginParse()
    const remainingBits = linkSlice.remainingBits

    if(remainingBits==0){
        return (await axios.get(pathBase)).data
    }

    const pathItem = bitsToPaddedBuffer(linkSlice.loadBits(linkSlice.remainingBits)).toString()

    return (await axios.get(pathBase+pathItem)).data
}

async function readNftMetadata(client: TonClient, address: string) : Promise<{
    persistenceType: persistenceType;
    metadata: { [s in JettonMetaDataKeys]?: string };
    isJettonDeployerFaultyOnChainData?: boolean;
}> {
    const nftCollectionAddress = Address.parse(address);
    const res = await client.runMethod(nftCollectionAddress, "get_collection_data")
    res.stack.skip(1)

    return await readContent(res);
}

async function readJettonMetadata(client: TonClient, address: string) : Promise<{
    persistenceType: persistenceType;
    metadata: { [s in JettonMetaDataKeys]?: string };
    isJettonDeployerFaultyOnChainData?: boolean;
}> {
    const jettonMinterAddress = Address.parse(address);

    const res = await client.runMethod( jettonMinterAddress, 'get_jetton_data');
    res.stack.skip(3)

    return await readContent(res)
}

function parseJettonOnchainMetadata(contentSlice: Slice) : {
    metadata: { [s in JettonMetaDataKeys]?: string };
    isJettonDeployerFaultyOnChainData: boolean;
} {

    const toKey = (str: string) => BigInt(`0x${str}`)
    const KEYLEN = 256;

    let isJettonDeployerFaultyOnChainData = false;

    const dict = parseDict(contentSlice.loadRef().beginParse(), KEYLEN, (s) => {
        let buffer = Buffer.from("");

        const sliceToVal = (s: Slice, v: Buffer, isFirst: boolean) => {
            s.asCell().beginParse();
            if (isFirst && s.loadUint(8) !== SNAKE_PREFIX)
                throw new Error("Only snake format is supported");

            const bits = s.remainingBits
            const bytes = bitsToPaddedBuffer(s.loadBits(bits))
            v = Buffer.concat([v, bytes]);
            if (s.remainingRefs === 1) {
                v = sliceToVal(s.loadRef().beginParse(), v, false);
            }

            return v;
        };

        if (s.remainingRefs === 0) {
            isJettonDeployerFaultyOnChainData = true;
            return sliceToVal(s, buffer, true);
        }

        return sliceToVal(s.loadRef().beginParse(), buffer, true);
    })

    const res: { [s in JettonMetaDataKeys]?: string } = {};

    Object.keys(jettonOnChainMetadataSpec).forEach((k) => {
        const val = dict
            .get(toKey(sha256(k).toString("hex")))
            ?.toString(jettonOnChainMetadataSpec[k as JettonMetaDataKeys]);
        if (val) res[k as JettonMetaDataKeys] = val;
    });
    return {
        metadata: res,
        isJettonDeployerFaultyOnChainData,
    };
}

async function parseJettonOffchainMetadata(contentSlice: Slice): Promise<{
    metadata: { [s in JettonMetaDataKeys]?: string };
    isIpfs: boolean;
}> {
    const bits = contentSlice.remainingBits
    const bytes = bitsToPaddedBuffer(contentSlice.loadBits(bits))
    const jsonURI = bytes
        .toString("ascii")
        .replace("ipfs://", "https://ipfs.io/ipfs/");

    return {
        metadata: (await axios.get(jsonURI)).data,
        isIpfs: /(^|\/)ipfs[.:]/.test(jsonURI),
    };
}

async function main() {
    const endpoint = await getHttpEndpoint({network: "mainnet"})
    const client = new TonClient({endpoint})
    const jettonData = await readJettonMetadata(client, 'EQANasbzD5wdVx0qikebkchrH64zNgsB38oC9PVu7rG16qNB')
    const nftData = await readNftMetadata(client, "EQCvYf5W36a0zQrS_wc6PMKg6JnyTcFU56NPx1PrAW63qpvt")
    const nftItemData = await readNftItemMetadata(client, "EQDTUKV5bMBh2SiL0eXgpO4XxPD1dp5DEpPR1fEIdHLJI40T")
    const jettonWalletData = await readJettonWalletMedata(client, "EQBhxsx1cHE34hrAM-hRRv7c26G57pe2G6Iw1LTn_5hOuRoV")
    console.log(jettonWalletData)
    // console.log(nftData)
    // console.log(nftItemData)
}

main()