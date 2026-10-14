import { Router } from 'express';
import { chat } from '../controllers/agentController.js';

const router = Router();
router.post('/chat', chat);

export default router;
