// 固定检索语料（corpus）的索引入口：agent 子进程与检索套件共用，避免语料或字段变化时改两处。
//
// corpus 是检索 / NLP 里的标准词，指“评测或检索用的一组固定文本”，
// 这里是 evals/retrieval/corpus.ts 里的一组短会话；不是语料库产品，也不是拼写错误。
import { indexConversationRun } from '../../../src/harness/knowledge/conversation-documents'
import type { EmbeddingProvider } from '../../../src/harness/knowledge/embedding-provider'
import type { Store } from '../../../src/harness/store'
import { RETRIEVAL_CORPUS } from './corpus'

export async function indexRetrievalCorpus(
  provider: EmbeddingProvider,
  store: Store,
): Promise<void> {
  for (const document of RETRIEVAL_CORPUS) {
    store.ensureConversation(document.conversationId, document.title, process.cwd())
    await indexConversationRun({
      provider,
      store,
      conversationId: document.conversationId,
      title: document.title,
      messages: document.messages,
    })
  }
}
