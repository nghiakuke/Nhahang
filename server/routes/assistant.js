'use strict';

/**
 * API Trợ lý AI — CHỈ dành cho tài khoản admin.
 *
 *   POST /api/assistant/chat { message }
 *     → { reply, actions: [{ action, ok, summary }], mode: 'parser'|'llm' }
 *
 * Hai chế độ:
 *   - Mặc định: parse lệnh tiếng Việt quen thuộc (miễn phí, offline).
 *   - Nếu cấu hình OPENAI_API_KEY: hiểu ngôn ngữ tự nhiên qua LLM.
 *     LLM lỗi thì tự rớt về parser.
 */

const express = require('express');
const { ApiError, asyncHandler, authenticate } = require('../middleware');
const { ACTIONS, HELP_TEXT } = require('../lib/assistant/actions');
const { parse } = require('../lib/assistant/parser');
const { llmChat, llmConfigured } = require('../lib/assistant/llm');

const router = express.Router();

/** Chạy một ý định do parser trích xuất. */
async function runIntent(intent, ctx) {
  if (intent?.reply) return { reply: intent.reply, actions: [] };
  if (!intent?.action || !ACTIONS[intent.action]) {
    return { reply: HELP_TEXT, actions: [] };
  }
  try {
    const r = await ACTIONS[intent.action].exec(intent.args || {}, ctx);
    return {
      reply: r?.message || 'Đã thực hiện xong ạ.',
      actions: [{ action: intent.action, ok: true, summary: r?.message || '' }],
    };
  } catch (e) {
    return {
      reply: `Không thực hiện được: ${e.message}`,
      actions: [{ action: intent.action, ok: false, summary: e.message }],
    };
  }
}

/** POST /api/assistant/chat { message } */
router.post(
  '/chat',
  authenticate,
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'admin') {
      throw new ApiError(403, 'Trợ lý AI toàn quyền chỉ dành cho quản trị viên');
    }
    const message = String(req.body?.message || '').trim();
    if (!message) throw new ApiError(400, 'Thiếu nội dung tin nhắn');

    const ctx = { user: req.user };

    if (llmConfigured()) {
      try {
        const { reply, actions } = await llmChat(message, ctx);
        return res.json({ reply, actions, mode: 'llm' });
      } catch (e) {
        const out = await runIntent(parse(message), ctx);
        return res.json({
          ...out,
          mode: 'parser',
          warning: `LLM không dùng được (${e.message}), đã chuyển sang chế độ lệnh`,
        });
      }
    }

    const intent = parse(message);
    res.json({ ...(await runIntent(intent, ctx)), mode: 'parser' });
  })
);

module.exports = { router };
