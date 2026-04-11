#!/usr/bin/env node

const axios = require('axios');

const qdrantUrl = process.argv[2] || 'http://localhost:6333';
const collection = process.argv[3] || 'user_impressions';

function clean(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function deriveScene(content) {
  const text = clean(content);

  if (/挽救计划|观影|CP|看哭|电影/.test(text)) {
    return '聊电影的真实观影视角和 CP 用法';
  }

  if (/面包店|早餐|下午茶|创业|铺面|设备|现金流/.test(text)) {
    return '聊开面包店计划';
  }

  if (/马拉松|跑步|膝盖|配速|备赛/.test(text)) {
    return '聊马拉松训练和膝盖问题';
  }

  return '聊当前对话场景';
}

function derivePoints(content) {
  const text = clean(content);

  if (/观影|CP|看哭|真实体验/.test(text)) {
    return [
      '用户很在意讨论必须锚定真实的观影视角，会拿自己真实的观看感受来校准聊天。',
      '围绕 CP 的泛化用法，用户从质疑慢慢转向接受，并开始分享自己对非恋爱向羁绊的情感共鸣。',
      '在概念被说清后，用户更愿意继续顺着自己的真实体验往下聊。'
    ];
  }

  const pieces = text
    .split(/[；。]/)
    .map((part) => clean(part))
    .filter(Boolean)
    .slice(0, 3);

  return pieces.length ? pieces : ['这条 impression 记录了一段可继续追踪的聊天场景。'];
}

function deriveRetrievalText(content, scene, points) {
  const text = clean(content);
  if (text) {
    return text;
  }
  return clean([scene, ...points].join('，'));
}

async function main() {
  const scroll = await axios.post(
    `${qdrantUrl}/collections/${collection}/points/scroll`,
    {
      limit: 200,
      with_payload: true,
      with_vector: false,
    },
  );

  const points = scroll.data.result?.points || [];
  const toUpdate = points.filter((point) => {
    const payload = point.payload || {};
    return !payload.scene || !Array.isArray(payload.points) || !payload.points.length || !payload.retrievalText;
  });

  for (const point of toUpdate) {
    const payload = point.payload || {};
    const content = clean(payload.content || '');
    const scene = deriveScene(content);
    const derivedPoints = derivePoints(content);
    const retrievalText = deriveRetrievalText(content, scene, derivedPoints);

    await axios.post(
      `${qdrantUrl}/collections/${collection}/points/payload`,
      {
        payload: {
          scene,
          points: derivedPoints,
          retrievalText,
        },
        points: [point.id],
      },
    );

    console.log(JSON.stringify({
      id: point.id,
      scene,
      points: derivedPoints,
      retrievalText,
    }));
  }
}

main().catch((error) => {
  console.error(error?.response?.data || error?.stack || error?.message || String(error));
  process.exit(1);
});
