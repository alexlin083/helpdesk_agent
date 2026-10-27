import { Router } from 'express';
import authRoutes from './routes/authRoutes.js';
import departmentRoutes from './routes/departmentRoutes.js';
import ticketRoutes from './routes/ticketRoutes.js';

const router = Router();

router.get('/health', (req, res) => {
  res.json({ success: true, data: { status: 'ok' } });
});

// 按功能分類：登入、部門名單、需求單。對話 API（/api/agent）已移除。
router.use('/auth', authRoutes);
router.use('/departments', departmentRoutes);
router.use('/tickets', ticketRoutes);

export default router;
