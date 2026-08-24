import { MongoClient, type Collection, type Db } from "mongodb";
import { env } from "../../config/env.js";
import type {
  AnalysisRecord,
  ContractRecord,
  LawChunk,
  LawSyncRecord,
  NegotiationRecord,
  TenantPreferences,
  UserRecord,
} from "../../domain/models.js";

export interface DataStore {
  close(): Promise<void>;
  createUser(user: UserRecord): Promise<void>;
  findUserByEmail(email: string): Promise<UserRecord | null>;
  findUserById(id: string): Promise<UserRecord | null>;
  updateUserPreferences(id: string, preferences: TenantPreferences): Promise<UserRecord | null>;
  createContract(contract: ContractRecord): Promise<void>;
  getContract(id: string): Promise<ContractRecord | null>;
  updateContract(contract: ContractRecord): Promise<void>;
  deleteContract(id: string): Promise<void>;
  createAnalysis(analysis: AnalysisRecord): Promise<void>;
  getAnalysis(id: string): Promise<AnalysisRecord | null>;
  findAnalysisByContract(contractId: string): Promise<AnalysisRecord | null>;
  listAnalyses(userId: string): Promise<AnalysisRecord[]>;
  deleteAnalysis(id: string): Promise<boolean>;
  getNegotiation(analysisId: string): Promise<NegotiationRecord | null>;
  upsertNegotiation(negotiation: NegotiationRecord): Promise<void>;
  getLawChunks(): Promise<LawChunk[]>;
  searchLawChunks(embedding: number[], topK: number): Promise<LawChunk[]>;
  saveLawSync(sync: LawSyncRecord): Promise<void>;
  replaceLawChunks(chunks: LawChunk[], sync: LawSyncRecord): Promise<void>;
}

export class MemoryDataStore implements DataStore {
  private readonly users = new Map<string, UserRecord>();
  private readonly contracts = new Map<string, ContractRecord>();
  private readonly analyses = new Map<string, AnalysisRecord>();
  private readonly negotiations = new Map<string, NegotiationRecord>();
  private lawChunks: LawChunk[] = [];

  async close() {}

  async createUser(user: UserRecord) {
    if ([...this.users.values()].some((candidate) => candidate.email === user.email)) {
      throw new Error("DUPLICATE_EMAIL");
    }
    this.users.set(user.id, structuredClone(user));
  }

  async findUserByEmail(email: string) {
    return structuredClone([...this.users.values()].find((user) => user.email === email) ?? null);
  }

  async findUserById(id: string) {
    return structuredClone(this.users.get(id) ?? null);
  }

  async updateUserPreferences(id: string, preferences: TenantPreferences) {
    const user = this.users.get(id);
    if (!user) return null;
    const updated = {
      ...user,
      preferences: structuredClone(preferences),
      updatedAt: new Date().toISOString(),
    };
    this.users.set(id, updated);
    return structuredClone(updated);
  }

  async createContract(contract: ContractRecord) {
    this.contracts.set(contract.id, structuredClone(contract));
  }

  async getContract(id: string) {
    return structuredClone(this.contracts.get(id) ?? null);
  }

  async updateContract(contract: ContractRecord) {
    this.contracts.set(contract.id, structuredClone(contract));
  }

  async deleteContract(id: string) {
    this.contracts.delete(id);
  }

  async createAnalysis(analysis: AnalysisRecord) {
    this.analyses.set(analysis.analysisId, structuredClone(analysis));
  }

  async getAnalysis(id: string) {
    return structuredClone(this.analyses.get(id) ?? null);
  }

  async findAnalysisByContract(contractId: string) {
    return structuredClone(
      [...this.analyses.values()].find((item) => item.contractId === contractId) ?? null,
    );
  }

  async listAnalyses(userId: string) {
    return [...this.analyses.values()]
      .filter((analysis) => analysis.userId === userId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((analysis) => structuredClone(analysis));
  }

  async deleteAnalysis(id: string) {
    return this.analyses.delete(id);
  }

  async getNegotiation(analysisId: string) {
    return structuredClone(this.negotiations.get(analysisId) ?? null);
  }

  async upsertNegotiation(negotiation: NegotiationRecord) {
    this.negotiations.set(negotiation.analysisId, structuredClone(negotiation));
  }

  async getLawChunks() {
    return structuredClone(this.lawChunks);
  }

  async searchLawChunks(embedding: number[], topK: number) {
    const magnitude = (values: number[]) => Math.sqrt(values.reduce((sum, value) => sum + value ** 2, 0));
    const queryMagnitude = magnitude(embedding);
    return this.lawChunks
      .filter((chunk) => chunk.embedding?.length === embedding.length)
      .map((chunk) => ({
        chunk,
        score: chunk.embedding!.reduce((sum, value, index) => sum + value * embedding[index]!, 0) /
          (magnitude(chunk.embedding!) * queryMagnitude || 1),
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, topK)
      .map(({ chunk }) => structuredClone(chunk));
  }

  async saveLawSync(_sync: LawSyncRecord) {}

  async replaceLawChunks(chunks: LawChunk[], _sync: LawSyncRecord) {
    this.lawChunks = structuredClone(chunks);
  }
}

class MongoDataStore implements DataStore {
  private constructor(private readonly client: MongoClient, private readonly db: Db) {}

  static async connect(uri: string) {
    const client = new MongoClient(uri);
    await client.connect();
    const store = new MongoDataStore(client, client.db(env.mongodbDatabase));
    await store.ensureIndexes();
    return store;
  }

  async close() {
    await this.client.close();
  }

  private collection<T extends object>(name: string): Collection<T> {
    return this.db.collection<T>(name);
  }

  private async ensureIndexes() {
    await Promise.all([
      this.collection<UserRecord>("users").createIndex({ email: 1 }, { unique: true }),
      this.collection<ContractRecord>("contracts").createIndex({ userId: 1, uploadedAt: -1 }),
      this.collection<AnalysisRecord>("analyses").createIndex({ userId: 1, createdAt: -1 }),
      this.collection<AnalysisRecord>("analyses").createIndex({ contractId: 1 }, { unique: true }),
      this.collection<NegotiationRecord>("negotiations").createIndex(
        { analysisId: 1 },
        { unique: true },
      ),
      this.collection<LawChunk>("law_chunks").createIndex({ id: 1 }, { unique: true }),
    ]);
  }

  async createUser(user: UserRecord) {
    await this.collection<UserRecord>("users").insertOne(user);
  }
  async findUserByEmail(email: string) {
    return this.collection<UserRecord>("users").findOne({ email });
  }
  async findUserById(id: string) {
    return this.collection<UserRecord>("users").findOne({ id });
  }
  async updateUserPreferences(id: string, preferences: TenantPreferences) {
    return this.collection<UserRecord>("users").findOneAndUpdate(
      { id },
      { $set: { preferences, updatedAt: new Date().toISOString() } },
      { returnDocument: "after" },
    );
  }
  async createContract(contract: ContractRecord) {
    await this.collection<ContractRecord>("contracts").insertOne(contract);
  }
  async getContract(id: string) {
    return this.collection<ContractRecord>("contracts").findOne({ id });
  }
  async updateContract(contract: ContractRecord) {
    await this.collection<ContractRecord>("contracts").replaceOne({ id: contract.id }, contract);
  }
  async deleteContract(id: string) {
    await this.collection<ContractRecord>("contracts").deleteOne({ id });
  }
  async createAnalysis(analysis: AnalysisRecord) {
    await this.collection<AnalysisRecord>("analyses").insertOne(analysis);
  }
  async getAnalysis(id: string) {
    return this.collection<AnalysisRecord>("analyses").findOne({ analysisId: id });
  }
  async findAnalysisByContract(contractId: string) {
    return this.collection<AnalysisRecord>("analyses").findOne({ contractId });
  }
  async listAnalyses(userId: string) {
    return this.collection<AnalysisRecord>("analyses")
      .find({ userId })
      .sort({ createdAt: -1 })
      .toArray();
  }
  async deleteAnalysis(id: string) {
    return (await this.collection<AnalysisRecord>("analyses").deleteOne({ analysisId: id }))
      .deletedCount === 1;
  }
  async getNegotiation(analysisId: string) {
    return this.collection<NegotiationRecord>("negotiations").findOne({ analysisId });
  }
  async upsertNegotiation(negotiation: NegotiationRecord) {
    await this.collection<NegotiationRecord>("negotiations").replaceOne(
      { analysisId: negotiation.analysisId },
      negotiation,
      { upsert: true },
    );
  }
  async getLawChunks() {
    return this.collection<LawChunk>("law_chunks").find().toArray();
  }
  async searchLawChunks(embedding: number[], topK: number) {
    return this.collection<LawChunk>("law_chunks")
      .aggregate<LawChunk>([
        {
          $vectorSearch: {
            index: env.mongodbVectorIndex,
            path: "embedding",
            queryVector: embedding,
            numCandidates: Math.max(topK * 20, 100),
            limit: topK,
          },
        },
        { $project: { _id: 0 } },
      ])
      .toArray();
  }
  async saveLawSync(sync: LawSyncRecord) {
    await this.collection<LawSyncRecord>("law_syncs").insertOne(sync);
  }
  async replaceLawChunks(chunks: LawChunk[], sync: LawSyncRecord) {
    const session = this.client.startSession();
    try {
      await session.withTransaction(async () => {
        await this.collection<LawChunk>("law_chunks").deleteMany({}, { session });
        if (chunks.length) {
          await this.collection<LawChunk>("law_chunks").insertMany(chunks, { session });
        }
        await this.collection<LawSyncRecord>("law_syncs").insertOne(sync, { session });
      });
    } finally {
      await session.endSession();
    }
  }
}

let storePromise: Promise<DataStore> | undefined;

export function getStore(): Promise<DataStore> {
  storePromise ??=
    env.dataDriver === "mongodb"
      ? MongoDataStore.connect(env.mongodbUri ?? "")
      : Promise.resolve(new MemoryDataStore());
  return storePromise;
}

export async function closeStore() {
  if (!storePromise) return;
  await (await storePromise).close();
  storePromise = undefined;
}
