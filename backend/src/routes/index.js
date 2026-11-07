import { Router } from 'express';
import authRoutes from './authRoutes.js';
import departmentRoutes from './departmentRoutes.js';
import requestTypeRoutes from './requestTypeRoutes.js';
import leaveRoutes from './leaveRoutes.js';
import meRoutes from './meRoutes.js';
import ticketRoutes from './ticketRoutes.js';

const router = Router();

router.get('/health', (req, res) => {
  res.json({ success: true, data: { status: 'ok' } });
});

// 按功能分類：登入、部門名單、需求類型清單、需求單（含自動生成對話）、本人資料與人資專用端點。對話 API 已移除。
router.use('/auth', authRoutes);
router.use('/departments', departmentRoutes);
router.use('/forms', requestTypeRoutes);
router.use('/tickets', ticketRoutes);
router.use('/me', meRoutes);
router.use('/leave', leaveRoutes);

export default router;
