'use strict';

/**
 * Kết nối LLM kiểu OpenAI (OpenAI / Gemini qua thư viện tương thích / proxy…)
 * cho Trợ lý AI. Khi có OPENAI_API_KEY trong .env, chat sẽ dùng LLM hiểu
 * ngữ cảnh tự nhiên; LLM chỉ CHỌN hành động, phần thực thi do server đảm
 * nhiệm (hàm exec trong actions.js) nên luôn đúng quyền và dữ liệu.
 *
 * Cấu hình (.env):
 *   OPENAI_API_KEY    khóa API (bắt buộc để bật chế độ này)
 *   OPENAI_MODEL      mô hình, mặc định gpt-4o-mini
 *   OPENAI_BASE_URL   endpoint tương thích, mặc định https://api.openai.com/v1
 */

const { ACTIONS } = require('./actions');

const BASE_URL = () => (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
const MODEL = () => process.env.OPENAI_MODEL || 'gpt-4o-mini';

const llmConfigured = () => Boolean(process.env.OPENAI_API_KEY);

/** Danh sách công cụ (hành động) gửi lên LLM. */
function toolsSchema() {
  return Object.entries(ACTIONS).map(([name, a]) => ({
    type: 'function',
    function: {
      name,
      description: a.desc,
      parameters: {
        type: 'object',
        properties: a.props,
        required: a.required || [],
        additionalProperties: false,
      },
    },
  }));
}

function systemPrompt(ctx) {
  return (
    `Bạn là trợ lý AI của phần mềm quản lý nhà hàng "${ctx.user.full_name}" (${ctx.user.role}). ` +
    'Bạn có TOÀN QUYỀN thao tác dữ liệu: đơn hàng, bàn, thực đơn, đặt bàn, khách hàng, nhân viên, báo cáo, cài đặt. ' +
    'Khi người dùng ra lệnh, hãy gọi tool phù hợp để THỰC HIỆN ngay (không hỏi xác nhận trừ khi thiếu thông tin bắt buộc). ' +
    'Sau khi có kết quả tool, trả lời ngắn gọn bằng tiếng Việt, thân thiện, nêu rõ đã làm gì và số liệu liên quan. ' +
    'Nếu lệnh mơ hồ hoặc thiếu thông tin, hỏi lại đúng chi tiết còn thiếu. Không bịa số liệu.'
  );
}

/**
 * Trò chuyện qua LLM, tự động thực thi các tool call trên server.
 * @returns {Promise<{ reply: string, actions: Array }>}
 */
async function llmChat(message, ctx, history = []) {
  const messages = [{ role: 'system', content: systemPrompt(ctx) }, ...history, { role: 'user', content: message }];
  const log = [];

  for (let round = 0; round < 6; round++) {
    const res = await fetch(`${BASE_URL()}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL(),
        messages,
        tools: toolsSchema(),
        tool_choice: 'auto',
        temperature: 0.2,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`LLM lỗi ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = await res.json();
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error('LLM không trả về nội dung');

    messages.push(msg);
    const calls = msg.tool_calls || [];
    if (!calls.length) {
      return { reply: msg.content || 'Đã thực hiện xong ạ.', actions: log };
    }

    for (const call of calls) {
      const name = call.function?.name;
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments || '{}');
      } catch {
        /* đối số hỏng → để exec báo lỗi rõ ràng */
      }
      try {
        const action = ACTIONS[name];
        if (!action) throw new Error(`Hành động "${name}" không tồn tại`);
        const r = await action.exec(args, ctx);
        log.push({ action: name, ok: true, summary: r?.message || '' });
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ ok: true, message: r?.message, data: r?.data ?? null }),
        });
      } catch (e) {
        log.push({ action: name, ok: false, summary: e.message });
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ ok: false, message: e.message }),
        });
      }
    }
  }

  return {
    reply: 'Mình đã thực hiện các bước trên. Bạn cần gì thêm không ạ?',
    actions: log,
  };
}

module.exports = { llmChat, llmConfigured };
