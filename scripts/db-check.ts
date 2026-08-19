/** 运维小工具：查看 SQLite 库内统计（npm run db:check） */
import { openDb } from '../src/db.js';

const d = openDb();
console.log('articles:', d.prepare('select count(*) n from articles').get());
console.log(
  'summaries:',
  d.prepare('select ver, count(*) n from summaries group by ver order by n desc').all(),
);
console.log(
  'runs(最近 5 次):',
  d
    .prepare(
      `select id, ok, articles_kept, summarized_ok, summarized_cached, summarized_failed,
              prompt_tokens, completion_tokens, datetime(finished_at / 1000, 'unixepoch', 'localtime') as finished
       from runs order by id desc limit 5`,
    )
    .all(),
);
console.log(
  'model_calls(按供应商):',
  d
    .prepare(
      `select provider, model, count(*) calls, sum(ok) ok,
              sum(coalesce(prompt_tokens, 0)) prompt_tokens, sum(coalesce(completion_tokens, 0)) completion_tokens,
              cast(avg(coalesce(latency_ms, 0)) as int) avg_latency_ms
       from model_calls group by provider, model`,
    )
    .all(),
);
