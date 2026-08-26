import { MongoClient, type Collection, type Db } from "mongodb";
import { env } from "../../config/env.js";
import type {
  AnalysisRecord,
  ContractRecord,
  LawEmbeddingRecord,
  LawSourceState,
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
  findAnalysisByInput(contractId: string, analysisInputHash: string): Promise<AnalysisRecord | null>;
  countAnalysesByContract(contractId: string): Promise<number>;
  listAnalyses(userId: string): Promise<AnalysisRecord[]>;
  deleteAnalysis(id: string): Promise<boolean>;
  getNegotiation(analysisId: string): Promise<NegotiationRecord | null>;
  upsertNegotiation(negotiation: NegotiationRecord): Promise<void>;
  deleteNegotiation(analysisId: string): Promise<void>;
  getLawSourceState(israelLawId: number): Promise<LawSourceState | null>;
  listLawSourceStates(): Promise<LawSourceState[]>;
  searchLawEmbeddings(embedding: number[], topK: number): Promise<LawEmbeddingRecord[]>;
  recordLawCheck(state: LawSourceState, sync: LawSyncRecord): Promise<void>;
  stageLawVersion(
    embeddings: LawEmbeddingRecord[],
    state: LawSourceState,
    sync: LawSyncRecord,
  ): Promise<void>;
  activateLawVersion(
    israelLawId: number,
    revisionId: number,
    contentHash: string,
    sectionCount: number,
    sectionsHash: string,
    verifiedBy: string,
    verificationReference: string,
  ): Promise<LawSourceState | null>;
  healthCheck(): Promise<{
    database: boolean;
    activeLawCount: number;
    activeEmbeddingCount: number;
    vectorSearch: boolean;
  }>;
  acquireLawSyncLease(ownerId: string, expiresAt: Date): Promise<boolean>;
  releaseLawSyncLease(ownerId: string): Promise<void>;
  consumeRateLimit(key: string, expiresAt: Date): Promise<number>;
}

export class MemoryDataStore implements DataStore {
  private readonly users = new Map<string, UserRecord>();
  private readonly contracts = new Map<string, ContractRecord>();
  private readonly analyses = new Map<string, AnalysisRecord>();
  private readonly negotiations = new Map<string, NegotiationRecord>();
  private lawEmbeddings: LawEmbeddingRecord[] = [];
  private readonly lawSourceStates = new Map<number, LawSourceState>();
  private readonly lawSyncs: LawSyncRecord[] = [];
  private readonly rateLimits = new Map<string, { count: number; expiresAt: Date }>();

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

  async findAnalysisByInput(contractId: string, analysisInputHash: string) {
    return structuredClone(
      [...this.analyses.values()].find((item) =>
        item.contractId === contractId && item.analysisInputHash === analysisInputHash) ?? null,
    );
  }

  async countAnalysesByContract(contractId: string) {
    return [...this.analyses.values()].filter((item) => item.contractId === contractId).length;
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

  async deleteNegotiation(analysisId: string) {
    this.negotiations.delete(analysisId);
  }

  async getLawSourceState(israelLawId: number) {
    return structuredClone(this.lawSourceStates.get(israelLawId) ?? null);
  }

  async listLawSourceStates() {
    return structuredClone([...this.lawSourceStates.values()]);
  }

  async searchLawEmbeddings(embedding: number[], topK: number) {
    const magnitude = (values: number[]) => Math.sqrt(values.reduce((sum, value) => sum + value ** 2, 0));
    const queryMagnitude = magnitude(embedding);
    return this.lawEmbeddings
      .filter((item) => item.status === "ACTIVE" && item.embedding.length === embedding.length)
      .map((item) => ({
        item,
        score: item.embedding.reduce((sum, value, index) => sum + value * embedding[index]!, 0) /
          (magnitude(item.embedding) * queryMagnitude || 1),
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, topK)
      .map(({ item }) => structuredClone(item));
  }

  async recordLawCheck(state: LawSourceState, sync: LawSyncRecord) {
    this.lawSourceStates.set(state.israelLawId, structuredClone(state));
    this.lawSyncs.push(structuredClone(sync));
  }

  async stageLawVersion(
    embeddings: LawEmbeddingRecord[],
    state: LawSourceState,
    sync: LawSyncRecord,
  ) {
    this.lawEmbeddings = this.lawEmbeddings.filter(
      (item) => item.israelLawId !== state.israelLawId || item.status !== "CANDIDATE",
    );
    this.lawEmbeddings.push(...structuredClone(embeddings));
    await this.recordLawCheck(state, sync);
  }

  async activateLawVersion(
    israelLawId: number,
    revisionId: number,
    contentHash: string,
    sectionCount: number,
    sectionsHash: string,
    verifiedBy: string,
    verificationReference: string,
  ) {
    const state = this.lawSourceStates.get(israelLawId);
    const candidates = this.lawEmbeddings.filter(
      (item) => item.israelLawId === israelLawId
        && item.revisionId === revisionId
        && item.status === "CANDIDATE",
    );
    if (state?.status !== "AWAITING_VERIFICATION"
      || state.candidateRevisionId !== revisionId
      || state.candidateContentHash !== contentHash
      || state.candidateSectionCount !== sectionCount
      || state.candidateSectionsHash !== sectionsHash
      || !candidates.length) return null;
    this.lawEmbeddings = this.lawEmbeddings.map<LawEmbeddingRecord>((item) => {
      if (item.israelLawId !== israelLawId) return item;
      if (item.revisionId === revisionId && item.status === "CANDIDATE") {
        return { ...item, status: "ACTIVE" };
      }
      return item.status === "ACTIVE" ? { ...item, status: "RETIRED" } : item;
    });
    const verifiedAt = new Date().toISOString();
    const active: LawSourceState = {
      ...state,
      status: "ACTIVE",
      activeOfficialFingerprint: state.candidateOfficialFingerprint,
      activeRevisionId: state.candidateRevisionId,
      activeSourceAsOf: state.candidateSourceAsOf,
      activeContentHash: state.candidateContentHash,
      activeSectionCount: state.candidateSectionCount,
      activeSectionsHash: state.candidateSectionsHash,
      activeSectionKeys: state.candidateSectionKeys,
      candidateOfficialFingerprint: null,
      candidateRevisionId: null,
      candidateSourceAsOf: null,
      candidateContentHash: null,
      candidateSectionCount: null,
      candidateSectionsHash: null,
      candidateSectionKeys: [],
      verifiedAt,
      verifiedBy,
      verificationReference,
      error: null,
    };
    this.lawSourceStates.set(israelLawId, active);
    return structuredClone(active);
  }

  async healthCheck() {
    const activeLawCount = [...this.lawSourceStates.values()].filter((state) => state.status === "ACTIVE").length;
    const activeEmbeddingCount = this.lawEmbeddings.filter((item) => item.status === "ACTIVE").length;
    return { database: true, activeLawCount, activeEmbeddingCount, vectorSearch: activeEmbeddingCount > 0 };
  }

  async acquireLawSyncLease() {
    return true;
  }

  async releaseLawSyncLease() {}

  async consumeRateLimit(key: string, expiresAt: Date) {
    const count = (this.rateLimits.get(key)?.count ?? 0) + 1;
    this.rateLimits.set(key, { count, expiresAt });
    if (this.rateLimits.size > 10_000) {
      const now = Date.now();
      for (const [candidate, record] of this.rateLimits) {
        if (record.expiresAt.getTime() <= now) this.rateLimits.delete(candidate);
      }
    }
    return count;
  }
}

type LawSyncLease = { _id: string; ownerId: string; expiresAt: Date };
type RateLimitRecord = { _id: string; count: number; expiresAt: Date };

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
    const analyses = this.collection<AnalysisRecord>("analyses");
    if (await analyses.indexExists("contractId_1")) await analyses.dropIndex("contractId_1");
    await Promise.all([
      this.collection<UserRecord>("users").createIndex({ email: 1 }, { unique: true }),
      this.collection<ContractRecord>("contracts").createIndex({ userId: 1, uploadedAt: -1 }),
      this.collection<AnalysisRecord>("analyses").createIndex({ userId: 1, createdAt: -1 }),
      analyses.createIndex({ contractId: 1, analysisInputHash: 1 }, {
        unique: true,
        partialFilterExpression: { analysisInputHash: { $type: "string" } },
      }),
      this.collection<NegotiationRecord>("negotiations").createIndex(
        { analysisId: 1 },
        { unique: true },
      ),
      this.collection<LawEmbeddingRecord>("law_embeddings").createIndex({ id: 1 }, { unique: true }),
      this.collection<LawEmbeddingRecord>("law_embeddings").createIndex(
        { israelLawId: 1, status: 1, revisionId: 1 },
      ),
      this.collection<LawSourceState>("law_source_states").createIndex(
        { israelLawId: 1 },
        { unique: true },
      ),
      this.collection<LawSyncRecord>("law_syncs").createIndex({ checkedAt: -1 }),
      this.collection<LawSyncRecord>("law_syncs").createIndex(
        { expiresAt: 1 },
        { expireAfterSeconds: 0 },
      ),
      this.collection<RateLimitRecord>("rate_limits").createIndex(
        { expiresAt: 1 },
        { expireAfterSeconds: 0 },
      ),
    ]);
    if (env.manageMongoVectorIndex) await this.ensureVectorSearchIndex();
  }

  private async ensureVectorSearchIndex() {
    const collection = this.collection<LawEmbeddingRecord>("law_embeddings");
    const existing = await collection.listSearchIndexes(env.mongodbVectorIndex).toArray();
    if (existing.length) return;
    await collection.createSearchIndex({
      name: env.mongodbVectorIndex,
      type: "vectorSearch",
      definition: {
        fields: [
          {
            type: "vector",
            path: "embedding",
            numDimensions: env.openAiEmbeddingDimensions,
            similarity: "cosine",
          },
          { type: "filter", path: "status" },
        ],
      },
    });
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
  async findAnalysisByInput(contractId: string, analysisInputHash: string) {
    return this.collection<AnalysisRecord>("analyses").findOne({ contractId, analysisInputHash });
  }
  async countAnalysesByContract(contractId: string) {
    return this.collection<AnalysisRecord>("analyses").countDocuments({ contractId });
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
  async deleteNegotiation(analysisId: string) {
    await this.collection<NegotiationRecord>("negotiations").deleteOne({ analysisId });
  }
  async getLawSourceState(israelLawId: number) {
    return this.collection<LawSourceState>("law_source_states").findOne({ israelLawId });
  }
  async listLawSourceStates() {
    return this.collection<LawSourceState>("law_source_states")
      .find()
      .sort({ israelLawId: 1 })
      .toArray();
  }
  async searchLawEmbeddings(embedding: number[], topK: number) {
    return this.collection<LawEmbeddingRecord>("law_embeddings")
      .aggregate<LawEmbeddingRecord>([
        {
          $vectorSearch: {
            index: env.mongodbVectorIndex,
            path: "embedding",
            queryVector: embedding,
            numCandidates: Math.max(topK * 20, 100),
            limit: topK,
            filter: { status: "ACTIVE" },
          },
        },
        { $project: { _id: 0 } },
      ])
      .toArray();
  }
  async recordLawCheck(state: LawSourceState, sync: LawSyncRecord) {
    await Promise.all([
      this.collection<LawSourceState>("law_source_states").replaceOne(
        { israelLawId: state.israelLawId },
        state,
        { upsert: true },
      ),
      this.collection<LawSyncRecord>("law_syncs").insertOne(sync),
    ]);
  }
  async stageLawVersion(
    embeddings: LawEmbeddingRecord[],
    state: LawSourceState,
    sync: LawSyncRecord,
  ) {
    const session = this.client.startSession();
    try {
      await session.withTransaction(async () => {
        await this.collection<LawEmbeddingRecord>("law_embeddings").deleteMany(
          { israelLawId: state.israelLawId, status: "CANDIDATE" },
          { session },
        );
        if (embeddings.length) {
          await this.collection<LawEmbeddingRecord>("law_embeddings").insertMany(
            embeddings,
            { session },
          );
        }
        await this.collection<LawSourceState>("law_source_states").replaceOne(
          { israelLawId: state.israelLawId },
          state,
          { upsert: true, session },
        );
        await this.collection<LawSyncRecord>("law_syncs").insertOne(sync, { session });
      });
    } finally {
      await session.endSession();
    }
  }

  async activateLawVersion(
    israelLawId: number,
    revisionId: number,
    contentHash: string,
    sectionCount: number,
    sectionsHash: string,
    verifiedBy: string,
    verificationReference: string,
  ) {
    const session = this.client.startSession();
    try {
      let active: LawSourceState | null = null;
      await session.withTransaction(async () => {
        const state = await this.collection<LawSourceState>("law_source_states").findOne(
          {
            israelLawId,
            candidateRevisionId: revisionId,
            candidateContentHash: contentHash,
            candidateSectionCount: sectionCount,
            candidateSectionsHash: sectionsHash,
            status: "AWAITING_VERIFICATION",
          },
          { session },
        );
        const candidateCount = await this.collection<LawEmbeddingRecord>("law_embeddings")
          .countDocuments({ israelLawId, revisionId, status: "CANDIDATE" }, { session });
        if (!state || !candidateCount) return;

        await this.collection<LawEmbeddingRecord>("law_embeddings").updateMany(
          { israelLawId, status: "ACTIVE" },
          { $set: { status: "RETIRED" } },
          { session },
        );
        await this.collection<LawEmbeddingRecord>("law_embeddings").updateMany(
          { israelLawId, revisionId, status: "CANDIDATE" },
          { $set: { status: "ACTIVE" } },
          { session },
        );
        active = {
          ...state,
          status: "ACTIVE",
          activeOfficialFingerprint: state.candidateOfficialFingerprint,
          activeRevisionId: state.candidateRevisionId,
          activeSourceAsOf: state.candidateSourceAsOf,
          activeContentHash: state.candidateContentHash,
          activeSectionCount: state.candidateSectionCount,
          activeSectionsHash: state.candidateSectionsHash,
          activeSectionKeys: state.candidateSectionKeys,
          candidateOfficialFingerprint: null,
          candidateRevisionId: null,
          candidateSourceAsOf: null,
          candidateContentHash: null,
          candidateSectionCount: null,
          candidateSectionsHash: null,
          candidateSectionKeys: [],
          verifiedAt: new Date().toISOString(),
          verifiedBy,
          verificationReference,
          error: null,
        };
        await this.collection<LawSourceState>("law_source_states").replaceOne(
          { israelLawId },
          active,
          { session },
        );
      });
      return active;
    } finally {
      await session.endSession();
    }
  }

  async healthCheck() {
    await this.db.command({ ping: 1 });
    const [activeLawCount, activeEmbeddingCount] = await Promise.all([
      this.collection<LawSourceState>("law_source_states").countDocuments({ status: "ACTIVE" }),
      this.collection<LawEmbeddingRecord>("law_embeddings").countDocuments({ status: "ACTIVE" }),
    ]);
    let vectorSearch = false;
    if (activeEmbeddingCount > 0) {
      const probe = Array.from({ length: env.openAiEmbeddingDimensions }, (_, index) => index === 0 ? 1 : 0);
      try {
        await this.searchLawEmbeddings(probe, 1);
        vectorSearch = true;
      } catch {
        vectorSearch = false;
      }
    }
    return { database: true, activeLawCount, activeEmbeddingCount, vectorSearch };
  }

  async acquireLawSyncLease(ownerId: string, expiresAt: Date) {
    const now = new Date();
    try {
      const lease = await this.collection<LawSyncLease>("scheduler_locks").findOneAndUpdate(
        {
          _id: "law-sync",
          $or: [{ expiresAt: { $lte: now } }, { ownerId }],
        },
        { $set: { ownerId, expiresAt } },
        { upsert: true, returnDocument: "after" },
      );
      return lease?.ownerId === ownerId;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === 11_000) return false;
      throw error;
    }
  }

  async releaseLawSyncLease(ownerId: string) {
    await this.collection<LawSyncLease>("scheduler_locks").deleteOne({ _id: "law-sync", ownerId });
  }

  async consumeRateLimit(key: string, expiresAt: Date) {
    const record = await this.collection<RateLimitRecord>("rate_limits").findOneAndUpdate(
      { _id: key },
      { $inc: { count: 1 }, $setOnInsert: { expiresAt } },
      { upsert: true, returnDocument: "after" },
    );
    return record?.count ?? 1;
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
