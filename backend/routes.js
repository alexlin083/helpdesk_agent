import { Router } from 'express';
import agentRoutes from './routes/agentRoutes.js';
import authRoutes from './routes/authRoutes.js';

const router = Router();

router.get('/health', (req, res) => {
  res.json({ success: true, data: { status: 'ok' } });
});

// 按功能分類；未來可在這裡掛載 /tickets、/users 等路由。
router.use('/agent', agentRoutes);
router.use('/auth', authRoutes);

export default router;
