// sqlite-vec 的 vec0 虚拟表封装：检索对比评测专用（重排 决策：不进产品运行时，
// 不打进 Electron 包——对比数字与理由见设计文档）。
//
// vec0 在 sqlite-vec 0.1.x 是 C 层的精确暴力扫描（不是 ANN 索引）：本套件对比的
// 是「向量留在 SQLite 里、C 层扫描」与「全量载入 JS 堆再算余弦」两条路的成本曲线，
// recall@k 理论上应与 JS 暴力完全一致（两者都精确），差异在延迟与内存路径。
//
// 实测锚点（2026-11-11，Node 25 / better-sqlite3 13.0.3 / darwin-arm64）：
// 加载用 db.loadExtension；主键必须是显式列（裸 rowid 插入报
// "Only integers are allowed for primary key values"）；
// 距离度量用 distance_metric=cosine，distance = 1 − 余弦相似度。
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'

/** 一次 KNN 查询的命中：id 指回插入时的块 id，distance 越小越相关 */
export interface Vec0SearchHit {
  id: string
  distance: number
}

/** vec0 表的最小操作面：建索引、查、关 */
export interface Vec0Index {
  /** 批量插入（一个事务）；重复 id 会报错——调用方保证语料唯一 */
  insert(items: Array<{ id: string; vector: Float32Array }>): void
  /** 余弦距离 KNN：按 distance 升序返回至多 topK 条 */
  search(queryVector: Float32Array, topK: number): Vec0SearchHit[]
  /** 关闭底层连接（:memory: 库随连接释放） */
  close(): void
}

/** 打开一个只装 vec0 表的内存库；dimensions 必须与向量一致 */
export function openVec0Index(dimensions: number): Vec0Index {
  const db = new Database(':memory:')
  sqliteVec.load(db)
  db.exec(
    `CREATE VIRTUAL TABLE vec_chunks USING vec0(
       chunk_id TEXT PRIMARY KEY,
       embedding float[${dimensions}] distance_metric=cosine
     )`,
  )

  const insertStatement = db.prepare(
    'INSERT INTO vec_chunks(chunk_id, embedding) VALUES (?, ?)',
  )
  const searchStatement = db.prepare(
    'SELECT chunk_id AS id, distance FROM vec_chunks WHERE embedding MATCH ? AND k = ? ORDER BY distance',
  )
  const insertAll = db.transaction((items: Array<{ id: string; vector: Float32Array }>) => {
    for (const item of items) {
      insertStatement.run(item.id, vectorToBuffer(item.vector))
    }
  })

  return {
    insert(items) {
      insertAll(items)
    },
    search(queryVector, topK) {
      const rows = searchStatement.all(vectorToBuffer(queryVector), topK) as Vec0SearchHit[]
      return rows
    },
    close() {
      db.close()
    },
  }
}

/** Float32Array 的底层字节即 vec0 期望的向量载荷；按 byteOffset/length 取，防共享 buffer 视图截错 */
function vectorToBuffer(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)
}
