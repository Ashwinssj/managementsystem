// api/performance_notes.ts
import { VercelRequest, VercelResponse } from '@vercel/node';
import { getConnection } from './utils/db';
import { sendApiResponse } from './utils/apiResponse';
import { authMiddleware } from './utils/authMiddleware';
import { PerformanceNote, User } from '../src/types/database.types'; // Corrected import path
import { PoolClient } from 'pg';

// Wrap the handler with authMiddleware
export default authMiddleware(async (req: VercelRequest & { user?: Omit<User, 'password'> }, res: VercelResponse) => {
    let client: PoolClient | undefined;
    try {
        client = await getConnection();

        const noteId = req.query.id ? parseInt(req.query.id as string, 10) : undefined;

        if (req.method === 'GET') {
            if (noteId !== undefined) {
                // Handle GET /api/performance_notes/:id
                const result = await client.query('SELECT id, player_id, coach_id, date, note, created_at, updated_at FROM performance_notes WHERE id = $1', [noteId]);
                const note = result.rows[0];

                if (!note) {
                    sendApiResponse(res, false, undefined, 'Performance note not found', 404);
                    return;
                }

                // Check if the authenticated user is an admin, the coach who created the note, or the player the note is about
                 let noteCreatorCoachUserId = null;
                 if (note.coach_id !== null) {
                     const coachUserResult = await client.query('SELECT user_id FROM coaches WHERE id = $1', [note.coach_id]);
                     noteCreatorCoachUserId = coachUserResult.rows[0]?.user_id || null;
                 }

                 const noteSubjectPlayerUserResult = await client.query('SELECT user_id FROM players WHERE id = $1', [note.player_id]);
                 const noteSubjectPlayerUserId = noteSubjectPlayerUserResult.rows[0]?.user_id || null;


                const isNoteCreatorCoach = note.coach_id !== null && req.user?.role === 'coach' && req.user.id === noteCreatorCoachUserId;
                const isNoteSubjectPlayer = req.user?.role === 'player' && req.user.id === noteSubjectPlayerUserId;


                if (req.user?.role !== 'admin' && !isNoteCreatorCoach && !isNoteSubjectPlayer) {
                     sendApiResponse(res, false, undefined, 'Access Denied', 403);
                     return;
                }

                sendApiResponse(res, true, note as PerformanceNote, undefined, 200);

            } else {
                // Handle GET /api/performance_notes
                let sql = 'SELECT id, player_id, coach_id, date, note, created_at, updated_at FROM performance_notes';
                const values: any[] = [];
                const conditions: string[] = [];
                let paramIndex = 1;

                if (req.user?.role === 'player') {
                     const playerResult = await client.query('SELECT id FROM players WHERE user_id = $1', [req.user.id]);
                     const player = playerResult.rows[0];

                     if (!player) {
                          sendApiResponse(res, false, undefined, 'Player profile not found', 404);
                          return;
                     }

                     conditions.push(`player_id = $${paramIndex++}`);
                     values.push(player.id);

                } else if (req.user?.role === 'coach') {
                     const coachResult = await client.query('SELECT id FROM coaches WHERE user_id = $1', [req.user.id]);
                     const coach = coachResult.rows[0];

                     if (coach) {
                          // Get notes created by this coach OR notes for players in their batches.
                          // Simplified: Just get notes created by this coach for now.
                          conditions.push(`coach_id = $${paramIndex++}`);
                          values.push(coach.id);
                          console.warn("Coach GET performance notes is simplified to only show notes created by the coach.");
                     } else {
                         sendApiResponse(res, true, [], undefined, 200);
                         return;
                     }
                } else if (req.user?.role !== 'admin') {
                     sendApiResponse(res, false, undefined, 'Access Denied', 403);
                     return;
                }

                if (req.user?.role === 'admin' || req.user?.role === 'coach') {
                     if (req.query.playerId !== undefined) {
                          conditions.push(`player_id = $${paramIndex++}`);
                          values.push(req.query.playerId);
                     }
                      if (req.query.coachId !== undefined) {
                          conditions.push(`coach_id = $${paramIndex++}`);
                          values.push(req.query.coachId);
                      }
                }

                if (conditions.length > 0) {
                     sql += ' WHERE ' + conditions.join(' AND ');
                }

                sql += ' ORDER BY date DESC, created_at DESC';

                const result = await client.query(sql, values);
                sendApiResponse(res, true, result.rows as PerformanceNote[], undefined, 200);
            }

        } else if (req.method === 'POST') {
            // Handle POST /api/performance_notes
            if (req.user?.role !== 'admin' && req.user?.role !== 'coach') {
                sendApiResponse(res, false, undefined, 'Access Denied', 403);
                return;
            }

            const { playerId, date, note, coachId } = req.body;

            if (!playerId || !date || !note) {
                sendApiResponse(res, false, undefined, 'Player ID, date, and note are required for performance note', 400);
                return;
            }

             let actualCoachId = coachId;
             if (req.user?.role === 'coach') {
                  const coachResult = await client.query('SELECT id FROM coaches WHERE user_id = $1', [req.user.id]);
                  actualCoachId = coachResult.rows[0]?.id || null;
             }

            const result = await client.query(
                'INSERT INTO performance_notes (player_id, coach_id, date, note) VALUES ($1, $2, $3, $4) RETURNING id',
                [playerId, actualCoachId, date, note]
            );
            const newNoteId = result.rows[0].id;

            sendApiResponse(res, true, { id: newNoteId }, undefined, 201);

        } else if (req.method === 'PUT') {
             // Handle PUT /api/performance_notes/:id
             if (noteId === undefined) {
                  sendApiResponse(res, false, undefined, 'Performance note ID is required for PUT method', 400);
                  return;
             }

             // Allow admin or the coach who created the note to update it
             const noteResult = await client.query('SELECT coach_id FROM performance_notes WHERE id = $1', [noteId]);
             const note = noteResult.rows[0];

             if (!note) {
                 sendApiResponse(res, false, undefined, 'Performance note not found', 404);
                 return;
             }

             let noteCreatorCoachUserId = null;
             if (note.coach_id !== null) {
                 const coachUserResult = await client.query('SELECT user_id FROM coaches WHERE id = $1', [note.coach_id]);
                 noteCreatorCoachUserId = coachUserResult.rows[0]?.user_id || null;
             }

             if (req.user?.role !== 'admin' && (req.user?.role !== 'coach' || req.user.id !== noteCreatorCoachUserId)) {
                 sendApiResponse(res, false, undefined, 'Access Denied', 403);
                 return;
             }

            const { date, note: noteContent } = req.body;
            const updateFields: string[] = [];
            const updateValues: any[] = [];
             let paramIndex = 1;

            if (date !== undefined) { updateFields.push(`date = $${paramIndex++}`); updateValues.push(date); }
            if (noteContent !== undefined) { updateFields.push(`note = $${paramIndex++}`); updateValues.push(noteContent); }


            if (updateFields.length === 0) {
                sendApiResponse(res, false, undefined, 'No valid fields provided for update', 400);
                return;
            }

            updateFields.push(`updated_at = CURRENT_TIMESTAMP`);
            updateValues.push(noteId);

            const sql = `UPDATE performance_notes SET ${updateFields.join(', ')} WHERE id = $${paramIndex}`;
            const result = await client.query(sql, updateValues);

            sendApiResponse(res, true, { affectedRows: result.rowCount }, undefined, 200);


        } else if (req.method === 'DELETE') {
             // Handle DELETE /api/performance_notes/:id
             if (noteId === undefined) {
                  sendApiResponse(res, false, undefined, 'Performance note ID is required for DELETE method', 400);
                  return;
             }

             // Allow admin or the coach who created the note to delete it
             const noteResult = await client.query('SELECT coach_id FROM performance_notes WHERE id = $1', [noteId]);
             const note = noteResult.rows[0];

             if (!note) {
                 sendApiResponse(res, false, undefined, 'Performance note not found', 404);
                 return;
             }

             let noteCreatorCoachUserId = null;
             if (note.coach_id !== null) {
                 const coachUserResult = await client.query('SELECT user_id FROM coaches WHERE id = $1', [note.coach_id]);
                 noteCreatorCoachUserId = coachUserResult.rows[0]?.user_id || null;
             }

             if (req.user?.role !== 'admin' && (req.user?.role !== 'coach' || req.user.id !== noteCreatorCoachUserId)) {
                 sendApiResponse(res, false, undefined, 'Access Denied', 403);
                 return;
             }

            const result = await client.query('DELETE FROM performance_notes WHERE id = $1', [noteId]);

            sendApiResponse(res, true, { affectedRows: result.rowCount }, undefined, 200);

        } else {
            sendApiResponse(res, false, undefined, 'Method Not Allowed', 405);
        }

    } catch (error) {
        console.error('Performance notes endpoint error:', error);
        sendApiResponse(res, false, undefined, error instanceof Error ? error.message : 'Failed to process performance notes request', 500);
    } finally {
        if (client) {
            client.release();
        }
    }
}, ['admin', 'coach', 'player']); // Allow admin (all methods), coach (GET, POST, PUT, DELETE if creator), player (GET if subject)

