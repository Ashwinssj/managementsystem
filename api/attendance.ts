// api/attendance.ts
import { VercelRequest, VercelResponse } from '@vercel/node';
import { getConnection } from './utils/db';
import { sendApiResponse } from './utils/apiResponse';
import { authMiddleware } from './utils/authMiddleware';
import { Attendance, User } from '../src/types/database.types'; // Corrected import path
import { PoolClient } from 'pg';

// Wrap the handler with authMiddleware
export default authMiddleware(async (req: VercelRequest & { user?: Omit<User, 'password'> }, res: VercelResponse) => {
    let client: PoolClient | undefined;
    try {
        client = await getConnection();

        const attendanceId = req.query.id ? parseInt(req.query.id as string, 10) : undefined;

        if (req.method === 'GET') {
            if (attendanceId !== undefined) {
                // Handle GET /api/attendance/:id
                const result = await client.query('SELECT id, session_id, player_id, status, comments, created_at, updated_at FROM session_attendance WHERE id = $1', [attendanceId]);
                const attendance = result.rows[0];

                if (!attendance) {
                    sendApiResponse(res, false, undefined, 'Attendance record not found', 404);
                    return;
                }

                // Check if the authenticated user is an admin, the coach of the associated session's batch, or the player themselves
                const relatedInfoResult = await client.query('SELECT b.coach_id, p.user_id AS player_user_id FROM session_attendance sa JOIN training_sessions ts ON sa.session_id = ts.id JOIN batches b ON ts.batch_id = b.id JOIN players p ON sa.player_id = p.id WHERE sa.id = $1', [attendanceId]);
                const relatedInfo = relatedInfoResult.rows[0];

                if (!relatedInfo) {
                     sendApiResponse(res, false, undefined, 'Related session, batch, or player not found', 404);
                     return;
                }

                // Fetch the user_id for the related coach if coach_id is not null
                let relatedCoachUserId = null;
                if (relatedInfo.coach_id !== null) {
                    const coachUserResult = await client.query('SELECT user_id FROM coaches WHERE id = $1', [relatedInfo.coach_id]);
                    relatedCoachUserId = coachUserResult.rows[0]?.user_id || null;
                }


                const isRelatedCoach = relatedInfo.coach_id !== null && req.user?.role === 'coach' && req.user.id === relatedCoachUserId;
                const isRelatedPlayer = req.user?.role === 'player' && req.user.id === relatedInfo.player_user_id;


                if (req.user?.role !== 'admin' && !isRelatedCoach && !isRelatedPlayer) {
                     sendApiResponse(res, false, undefined, 'Access Denied', 403);
                     return;
                }

                sendApiResponse(res, true, attendance as Attendance, undefined, 200);

            } else {
                // Handle GET /api/attendance
                let sql = 'SELECT id, session_id, player_id, status, comments, created_at, updated_at FROM session_attendance';
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
                         conditions.push(`session_id IN (SELECT ts.id FROM training_sessions ts JOIN batches b ON ts.batch_id = b.id WHERE b.coach_id = $${paramIndex++})`);
                         values.push(coach.id);
                     } else {
                         sendApiResponse(res, true, [], undefined, 200);
                         return;
                     }
                } else if (req.user?.role !== 'admin') {
                     sendApiResponse(res, false, undefined, 'Access Denied', 403);
                     return;
                }

                if (req.user?.role !== 'player') {
                     if (req.query.sessionId !== undefined) {
                          conditions.push(`session_id = $${paramIndex++}`);
                          values.push(req.query.sessionId);
                     }
                      if (req.query.playerId !== undefined) {
                          conditions.push(`player_id = $${paramIndex++}`);
                          values.push(req.query.playerId);
                     }
                }

                if (conditions.length > 0) {
                     sql += ' WHERE ' + conditions.join(' AND ');
                }

                sql += ' ORDER BY created_at DESC';

                const result = await client.query(sql, values);
                sendApiResponse(res, true, result.rows as Attendance[], undefined, 200);
            }

        } else if (req.method === 'POST') {
            // Handle POST /api/attendance
            if (req.user?.role !== 'admin' && req.user?.role !== 'coach') {
                sendApiResponse(res, false, undefined, 'Access Denied', 403);
                return;
            }

            const { sessionId, playerId, status, comments } = req.body;

            if (!sessionId || !playerId || !status) {
                sendApiResponse(res, false, undefined, 'Session ID, Player ID, and status are required for attendance', 400);
                return;
            }

            const result = await client.query(
                'INSERT INTO session_attendance (session_id, player_id, status, comments) VALUES ($1, $2, $3, $4) RETURNING id',
                [sessionId, playerId, status, comments || null]
            );
            const newAttendanceId = result.rows[0].id;

            sendApiResponse(res, true, { id: newAttendanceId }, undefined, 201);

        } else if (req.method === 'PUT') {
             // Handle PUT /api/attendance/:id
             if (attendanceId === undefined) { // Corrected variable name
                  sendApiResponse(res, false, undefined, 'Attendance ID is required for PUT method', 400);
                  return;
             }

             // Check if the authenticated user is an admin or the coach of the associated session's batch
             const relatedInfoResult = await client.query('SELECT b.coach_id FROM session_attendance sa JOIN training_sessions ts ON sa.session_id = ts.id JOIN batches b ON ts.batch_id = b.id WHERE sa.id = $1', [attendanceId]);
             const relatedInfo = relatedInfoResult.rows[0];

              if (!relatedInfo) {
                  sendApiResponse(res, false, undefined, 'Associated session or batch not found', 404);
                  return;
              }

              let relatedCoachUserId = null;
              if (relatedInfo.coach_id !== null) {
                   const coachUserResult = await client.query('SELECT user_id FROM coaches WHERE id = $1', [relatedInfo.coach_id]);
                   relatedCoachUserId = coachUserResult.rows[0]?.user_id || null;
              }

             if (req.user?.role !== 'admin' && (req.user?.role !== 'coach' || req.user.id !== relatedCoachUserId)) {
                 sendApiResponse(res, false, undefined, 'Access Denied', 403);
                 return;
             }


            const { status, comments } = req.body;
            const updateFields: string[] = [];
            const updateValues: any[] = [];
             let paramIndex = 1;

            if (status !== undefined) {
                 if (!['present', 'absent', 'excused'].includes(status)) {
                      sendApiResponse(res, false, undefined, 'Invalid status specified', 400);
                      return;
                 }
                 updateFields.push(`status = $${paramIndex++}`); updateValues.push(status);
            }
            if (comments !== undefined) { updateFields.push(`comments = $${paramIndex++}`); updateValues.push(comments); }


            if (updateFields.length === 0) {
                sendApiResponse(res, false, undefined, 'No valid fields provided for update', 400);
                return;
            }

            updateFields.push(`updated_at = CURRENT_TIMESTAMP`);
            updateValues.push(attendanceId);

            const sql = `UPDATE session_attendance SET ${updateFields.join(', ')} WHERE id = $${paramIndex}`;
            const result = await client.query(sql, updateValues);

            sendApiResponse(res, true, { affectedRows: result.rowCount }, undefined, 200);


        } else if (req.method === 'DELETE') {
             // Handle DELETE /api/attendance/:id
             if (attendanceId === undefined) { // Corrected variable name
                  sendApiResponse(res, false, undefined, 'Attendance ID is required for DELETE method', 400);
                  return;
             }

             // Allow admin or the coach of the associated session's batch to delete attendance
              const relatedInfoResult = await client.query('SELECT b.coach_id FROM session_attendance sa JOIN training_sessions ts ON sa.session_id = ts.id JOIN batches b ON ts.batch_id = b.id WHERE sa.id = $1', [attendanceId]);
              const relatedInfo = relatedInfoResult.rows[0];

               if (!relatedInfo) {
                   sendApiResponse(res, false, undefined, 'Associated session or batch not found', 404);
                   return;
               }

               let relatedCoachUserId = null;
               if (relatedInfo.coach_id !== null) {
                   const coachUserResult = await client.query('SELECT user_id FROM coaches WHERE id = $1', [relatedInfo.coach_id]);
                   relatedCoachUserId = coachUserResult.rows[0]?.user_id || null;
               }


             if (req.user?.role !== 'admin' && (req.user?.role !== 'coach' || req.user.id !== relatedCoachUserId)) {
                 sendApiResponse(res, false, undefined, 'Access Denied', 403);
                 return;
             }

             // No dependent records for attendance, can delete directly
            const result = await client.query('DELETE FROM session_attendance WHERE id = $1', [attendanceId]); // Corrected variable name

            sendApiResponse(res, true, { affectedRows: result.rowCount }, undefined, 200);

        } else {
            sendApiResponse(res, false, undefined, 'Method Not Allowed', 405);
        }

    } catch (error) {
        console.error('Attendance endpoint error:', error);
        sendApiResponse(res, false, undefined, error instanceof Error ? error.message : 'Failed to process attendance request', 500);
    } finally {
        if (client) {
            client.release();
        }
    }
}, ['admin', 'coach', 'player']); // Allow admin, coach (all methods), player (GET their own)

