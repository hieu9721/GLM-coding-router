# GLM Coding Router — Agent Communication & Context Reuse

Ngày nghiên cứu: **2026-09-22**. Trạng thái: **ĐỀ XUẤT, CHƯA TRIỂN KHAI**.
Build/research spec: [context-reuse](../specs/context-reuse.md).
Liên quan: [v2 architecture](../specs/v2-architecture.md) và
[v3 role switching](GLM%20Coding%20Router%20v3%20%E2%80%94%20Claude%20Code%20-%20Codex%20-%20ZCode%20Role%20Switching.md).

## 1. Kết luận đề xuất

Mục tiêu khả thi là **worker không phải khám phá lại toàn bộ dự án cho mỗi task**.
Worker vẫn cần đọc code hiện tại ở phần sẽ sửa, các phụ thuộc quan trọng và instruction
bắt buộc. Một bản tóm tắt không thay thế việc kiểm tra dữ liệu đã thay đổi.

Kiến trúc phù hợp cho router này:

1. Bản đồ dự án ngắn, ổn định, có tham chiếu đến nguồn.
2. Gói ngữ cảnh chỉ gồm module, hợp đồng và test liên quan đến task.
3. Tiếp tục đúng session khi sửa tiếp cùng công việc; task khác dùng session mới.
4. Agent trao đổi yêu cầu/kết quả có cấu trúc và tham chiếu artifact, không chuyển
   toàn bộ transcript qua lại.
5. Đo chi phí **để có một kết quả được nghiệm thu**, gồm planner, worker, review,
   chuẩn bị context và các lần thử lại.

Chưa có benchmark chứng minh mức tiết kiệm của thiết kế này trên repo. Những ngân
sách/ngưỡng bên dưới là giả thuyết để thử, không phải số hiệu năng đã đạt.

## 2. Bằng chứng từ repo hiện tại

Đối chiếu source tại `c0867ac`; chỉ đọc source và fixture được commit, không đọc
lịch sử cá nhân hoặc secret.

| Phát hiện | Ý nghĩa cho tối ưu |
|---|---|
| `buildWorkerArgs` / `buildReviewArgs` tạo `claude -p` và không thêm `--resume` | Các lần gọi wrapper hiện chưa chủ động tiếp tục session trước |
| Adapter chuyển `system/init.session_id` thành `AgentInitialized.sessionId`; event store lưu event này | Đã có session ID để xây cơ chế resume có kiểm soát, không cần đoán phiên gần nhất |
| `RunCompleted` chỉ lấy `usage.input_tokens` và `output_tokens` | Thiếu cache-read/cache-write trong báo cáo token chuẩn hóa |
| Fixture có cache counters thực tế | Có dữ liệu khởi đầu để kiểm thử parser mà không tốn quota |
| Checkpoint/handoff lưu file thay đổi, việc đã làm và validation còn thiếu | Hữu ích cho tiếp nối task nhưng chưa phải kiến thức kiến trúc dự án đầy đủ |
| MCP chủ yếu nhận `prompt`/`profile`; delegate nhận prompt và tạo worktree | Chưa có hợp đồng task-context có version và truy vết freshness |
| `cost-samples.jsonl` lưu credit delta, model, turns, retries và validation | Có nền cho đánh giá chi phí, cần thêm chất lượng nghiệm thu và độ tin cậy đo |

Nguồn: [worker args](../src/bin/glm-worker.ts), [review args](../src/bin/glm-review.ts),
[adapter](../src/events/claude-adapter.ts), [events](../src/events/types.ts),
[store](../src/runs/store.ts), [measurement](../src/runs/worker-run.ts),
[checkpoint](../src/runs/checkpoint.ts), [MCP](../src/mcp/server.ts).

Đọc phần `result.usage` của ba fixture ngày 2026-09-20 cho kết quả:

| Fixture | Input mới | Cache-read | Cache-write | Tổng input theo các trường | Output |
|---|---:|---:|---:|---:|---:|
| `basic.ndjson` | 1.644 | 7.168 | 0 | 8.812 | 144 |
| `allowed.ndjson` | 339 | 8.448 | 0 | 8.787 | 111 |
| `edit.ndjson` | 2.145 | 16.640 | 0 | 18.785 | 545 |

Nguồn trực tiếp: [basic](../tests/fixtures/streams/basic.ndjson),
[allowed](../tests/fixtures/streams/allowed.ndjson), [edit](../tests/fixtures/streams/edit.ndjson).
Đây là số liệu fixture, **không phải benchmark so sánh cold/resume**, không chứng minh
cache được chia sẻ giữa mọi session hoặc mọi model. `tokensIn` cũ không đủ để gọi là
toàn bộ input. Không dùng `total_cost_usd` do Claude Code suy ra cho model GLM làm hóa đơn.

Một nguồn chi phí nền khác: tại thời điểm nghiên cứu, `AGENTS.md` khoảng 14 KB,
`MEMORY.md` khoảng 30 KB dù chỉ 135 dòng. Các instruction hiện yêu cầu đọc chúng.
Giới hạn số dòng chưa đảm bảo ngân sách context nhỏ. Đề xuất sau này đưa log dài đã
xong vào archive và giữ index/current state ngắn; chưa thay cấu trúc instruction ở đây.

## 3. Những cơ chế thường bị nhầm với nhau

| Cơ chế | Giúp gì | Không đảm bảo điều gì |
|---|---|---|
| File memory / project map | Worker tìm đúng nơi nhanh hơn | Không tự nằm trong context; vẫn tốn token khi được đọc |
| Tiếp tục session | Giữ hội thoại, kết quả tool và quyết định liên quan | Lịch sử không miễn phí và có thể đã cũ |
| Prompt cache của provider | Tái sử dụng xử lý input và có thể giảm giá input | Không thay thế memory, không tự tăng context window |
| Chọn context theo task | Giảm thông tin thừa gửi cho worker | Có thể bỏ sót phụ thuộc nếu chọn sai |
| Index file/symbol local | Giảm truy tìm bằng LLM | Index cần cập nhật; đọc đĩa ít hơn không đồng nghĩa token ít hơn |

OpenAI mô tả cache theo phần đầu prompt trùng khớp và lưu ý giữ session không đảm
bảo cache hit. Đây là hướng dẫn API; không suy diễn thành mức giảm quota của Codex
subscription hoặc Z.ai. [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).

Claude Code hỗ trợ tiếp tục bằng session ID; Codex non-interactive cũng có resume
theo ID. Đây là khả năng của từng runtime, không phải cam kết resume xuyên provider.
[Claude Code headless](https://code.claude.com/docs/en/headless),
[Codex non-interactive](https://learn.chatgpt.com/docs/non-interactive-mode).

Claude Code khuyên giữ instruction ngắn và chuyển kiến thức chuyên biệt sang tài
liệu/skill đọc theo nhu cầu. Auto memory của Claude Code là cơ chế riêng; đừng nhầm
với `MEMORY.md` ở root repo này. [Claude Code memory](https://code.claude.com/docs/en/memory).

## 4. Chi phí thật trên GLM Coding Plan

Theo tài liệu Z.ai truy cập ngày 2026-09-22, công thức credit phân biệt input thường,
input cache và output. Bảng dưới là snapshot tham khảo, không hardcode vào routing:

| Model | Input thường | Input cache | Output |
|---|---:|---:|---:|
| GLM-5.3 | 6,9 | 1,7 | 24 |
| GLM-5.3-Flash | 2,3 | 0,56 | 8 |

```text
credit = (input_thuong * he_so_input
        + input_cache * he_so_cache
        + output * he_so_output) / 10000
```

Tài liệu còn có mức off-peak và ưu đãi theo thời gian; benchmark phải ghi thời điểm
và điều kiện giá, không trộn chúng thành lợi ích của context reuse.
[Z.ai Coding Plan — Credit Calculation](https://docs.z.ai/devpack/overview#credit-calculation).

Z.ai công bố implicit context cache, có trường cached tokens trong API ví dụ.
TTL, tỷ lệ hit và cách quy đổi từng trường qua lớp Anthropic-compatible của repo vẫn
cần kiểm chứng. Không áp nguyên TTL/chi phí cache-write của Anthropic lên Z.ai.
[Z.ai context caching](https://docs.z.ai/guides/capabilities/cache).

**Minh họa tính toán**, GLM-5.3 với 10.000 input + 1.000 output, chưa áp hệ số khác:
toàn input mới = 9,3 credits; 8.000 cache + 2.000 mới = 5,14 credits (giảm 44,7%).
Đây không phải kết quả đo router; các lượt làm lại có thể xóa lợi ích này.

Đếm token phải theo đúng provider: Anthropic tách input mới, cache creation và cache
read; tổng input là tổng ba trường. Không cộng lại cached tokens nếu một API khác đã
tính chúng trong input tổng. [Anthropic usage accounting](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#tracking-cache-performance).

## 5. Thiết kế context theo ba tầng

```text
Instruction bắt buộc + Project map ổn định
                     |
Task packet + module refs + acceptance tests + workspace revision
                     |
Code hiện tại cần sửa / phụ thuộc cần kiểm tra, đọc khi cần
                     |
Worker -> kết quả ngắn + evidence refs -> orchestrator nghiệm thu
```

### Tầng nền: bản đồ dự án

Giữ mục đích, entry points, ranh giới module, lệnh validation, bất biến và các bẫy
đã xác nhận. Các mục kiến trúc trỏ về source/spec; mỗi mẩu có provenance và version.
Không nhét toàn bộ technical specification, lịch sử thảo luận hoặc implementation
chi tiết vào mỗi task. Mục tiêu thử nghiệm: project map bổ sung khoảng 800–1.500 token,
không gồm instruction bắt buộc. Token budget không được cắt instruction của người dùng.

Aider là ví dụ thực tế dùng repo map gồm symbol và quan hệ phụ thuộc, chọn phần liên
quan dưới ngân sách token. Ta có thể học cách chọn context mà chưa cần thêm vector
database hoặc embedding service. [Aider repository map](https://aider.chat/docs/repomap.html).

### Tầng task: gói giao việc

Gói cần đủ mục theo AGENTS.md: TASK, SCOPE, FILES ALLOWED/NOT TO MODIFY, REQUIREMENTS,
CONSTRAINTS, ACCEPTANCE CRITERIA, VALIDATION, EXPECTED OUTPUT. Rút gọn nội dung, không
bỏ hợp đồng giao việc. Bổ sung:

- Task/attempt ID, worktree, revision và hash của file liên quan.
- Đọc đầu tiên ở đâu; symbol/hợp đồng nào cần giữ; test nào là bằng chứng.
- Điều gì đã được orchestrator xác nhận, điều gì còn là giả thuyết.
- Delta từ attempt trước và lý do retry, thay vì paste cả transcript.
- Báo thiếu context bằng tên file/symbol/câu hỏi cụ thể.

Worker vẫn đọc instruction hiện hành. `allowedFiles` là phạm vi giao việc, không
phải sandbox được enforce chỉ nhờ một chuỗi trong prompt.

### Tầng động: đọc đúng phần cần thiết

Ưu tiên symbol/đường dẫn cụ thể, range có ngữ cảnh, import/caller và test liên quan.
Trước khi sửa phải đọc phiên bản file hiện tại. Thay đổi ở API công khai, config,
lockfile hoặc instruction làm mở rộng phạm vi kiểm tra. Không cấm mọi lượt Read để
đạt một chỉ số đẹp; ghi lại lý do cần mở rộng context.

Summary chỉ là chỉ mục có thể sai, không có thẩm quyền ghi đè spec/code mới hơn.
Approach này phù hợp với hướng just-in-time retrieval và context chọn lọc, nhưng
thiết kế cụ thể ở đây là đề xuất cho repo. [Anthropic context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents).

## 6. Agent giao tiếp thế nào để tiết kiệm

Đề xuất mô hình một orchestrator điều phối; workers nhận task độc lập hoặc phụ thuộc
rõ ràng. Workers không broadcast tiến độ cho mọi agent và không tự gọi vòng lặp
worker khác. Giữ strict MCP isolation hiện có.

| Message | Nội dung tối thiểu | Có cần đánh thức LLM không? |
|---|---|---|
| Assignment | Hợp đồng task + context refs + hạn mức | Có, để làm việc |
| NeedContext | Câu hỏi cụ thể, file/symbol còn thiếu | Router có thể cung cấp refs bằng logic deterministic |
| Checkpoint | Phase, file đã sửa, validation, việc còn lại | Lưu/xử lý bằng code; không cần một lượt suy nghĩ để xác nhận |
| Result | Kết luận, changed files, evidence, limitation | Orchestrator review ở mốc cần quyết định |
| Failure / DecisionRequired | Mã lý do, bằng chứng, quyết định còn thiếu | Đánh thức orchestrator khi thực sự cần |

Heartbeat là dữ liệu liveness, không phải lời nhắn “vẫn đang làm” khiến model phải
trả lời. Artifact refs tránh copy log/test/diff dài; người nhận chỉ tải phần cần.
Giữ transcript/raw logs ngoài router history theo hợp đồng C3; không tạo kho log
mới chứa source/secret chỉ để tiết kiệm context.

Task nhỏ liên quan nên gom thành một đơn vị nghiệm thu, ví dụ implement + test
module. Chia quá vụn làm lặp onboarding; gộp quá lớn tăng max-turn failures và review.
Parallel chỉ khi việc đủ độc lập và chi phí phối hợp chấp nhận được; nhanh hơn không
đồng nghĩa rẻ hơn. CLI hay MCP là lựa chọn vận chuyển, không tự bảo đảm giảm token.

## 7. Resume có chọn lọc

| Tình huống | Đề xuất |
|---|---|
| Sửa lỗi validation của chính task vừa làm, cùng worktree/model/quyền | Resume đúng session ID, gửi delta |
| Thêm test cho module vừa triển khai trong cùng nhóm task | Có thể resume, kiểm tra ngân sách lịch sử |
| Task không liên quan, context cũ lớn | Fresh session + map/task packet |
| Chuyển provider/runtime hoặc đổi quyền reviewer -> worker | Fresh session + handoff có cấu trúc |
| File đổi ngoài session, instruction đổi, session thiếu/mơ hồ | Làm mới context; fresh nếu không chứng minh được tương thích |

Không dùng “phiên gần nhất” trong router nhiều worker: session của người dùng hoặc
task khác có thể bị chọn nhầm. Một session chỉ có một người giữ quyền chạy tại một
thời điểm; kiểm tra canonical worktree, role, model, tool policy và revision.

History dài phải có điểm kết thúc. Nghiên cứu Claude Code chỉ ra các lượt sau vẫn
mang lịch sử; compaction cũng có chi phí. Do đó cần đo resume, fresh và handoff ngắn
trên cùng loại task; không giữ session sống để tự động “warm cache”.
[Claude Code cost management](https://code.claude.com/docs/en/costs#reduce-token-usage).

## 8. Freshness và dữ liệu được phép lưu

Cache local của router lưu **metadata**: repo/worktree ID, file hash, symbol refs,
context version, runtime session ID, structured checkpoint và metrics. Nó không là
bản sao codebase hay transcript. Tài liệu kiến trúc authored trong repo là nguồn
tham chiếu; router không tự lưu toàn bộ câu trả lời model thành project memory.

HEAD chưa đủ: staged, unstaged và untracked file liên quan đều có thể đổi mà commit
không đổi. Hash theo nội dung của input/task dependencies, instruction và cấu hình
build; mismatch làm invalidation có mục tiêu. TTL chỉ là hỗ trợ, không là bằng chứng
summary còn đúng. Metadata không thay thế code ở worktree thực tế.

Session transcript gốc do runtime quản lý có chính sách lưu riêng. Router chỉ tham
chiếu ID; không sao chép transcript vào `runs/`, không đọc hidden reasoning để tạo memory.
Tách repo/worktree và role để tránh task này nhận nhầm dữ liệu của task khác.

## 9. Đo lường và nghiên cứu tiếp theo

Chỉ số chính: credit hoặc chi phí **trên task được nghiệm thu**, tỷ lệ đạt, thời gian
tới kết quả nghiệm thu. Chỉ số phụ: input mới/cache-read/cache-write/output, thời gian
tới edit đầu tiên, số file đọc lại trước edit, tool calls, retries, review/rework và
context bị invalidation. Thiếu counter phải là unknown, không ghi 0 giả.

Credit delta có thể lẫn usage ngoài router, reset và độ trễ cập nhật; giữ nhãn nguồn
đo/độ tin cậy. Parent Codex/Claude subscription có thể thiếu số đo theo task: báo riêng
và nói rõ thiếu, không chuyển GLM credits thành USD hoặc gộp quota khác provider.

Thử bốn biến thể, cùng task/revision/model/test:

- A: fresh worker, giao việc hiện tại.
- B: fresh worker + map nhỏ + context theo task.
- C: B + resume khi sửa tiếp một task liên quan.
- D: chuỗi có task không liên quan, so sánh giữ session với fresh/handoff ngắn.

Bắt đầu pilot nhỏ, giới hạn chi phí và lặp có thứ tự hoán đổi; ghi trạng thái cache
quan sát được vì không kiểm soát hoàn toàn cache provider. Tính cả công tạo/cập nhật
map; báo riêng lần đầu và mức khấu hao nhiều task. Chỉ mở rộng sample khi pilot có
tín hiệu, không kết luận p90 từ vài run. Chưa chạy benchmark trong nghiên cứu này.

Ngày 2026-09-22, một lượt `glm-review` khảo sát chỉ đọc bị lỗi HTTP 401 trước khi
khảo sát source. Lượt đó không sửa file và không cung cấp bằng chứng hiệu năng;
nghiên cứu tiếp tục bằng đọc local + nguồn chính thức. Auth ổn định là điều kiện để
chạy thử live về sau. Các tính năng đề xuất vẫn chưa triển khai.

## 10. Thứ tự ưu tiên

**P0:** bổ sung đo cache/token đúng nghĩa và baseline. **P1:** project map, task packet,
file refs và invalidation. **P2:** resume được khóa đúng session cho nhóm task liên quan.
**P3:** protocol message/event gắn TaskGraph/ExecutionLease của v3.

Chưa cần làm vector database, agent mesh tự chat hoặc memory lâu dài tự viết. Trước
khi chọn chúng, phải chứng minh cách đơn giản hơn không đáp ứng được yêu cầu tìm ngữ
cảnh và tính đúng. Bản cập nhật UI/doctor và nghiên cứu này là hai nhánh đề xuất riêng.
