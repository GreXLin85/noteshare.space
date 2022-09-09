import { EncryptedNote } from "@prisma/client";
import { NextFunction, Request, Response } from "express";
import { crc16 as crc } from "crc";
import { createNote } from "../../db/note.dao";
import { addDays, getConnectingIp } from "../../util";
import EventLogger, { WriteEvent } from "../../logging/EventLogger";
import {
  validateOrReject,
  IsBase64,
  IsHexadecimal,
  IsNotEmpty,
  ValidateIf,
  ValidationError,
  Matches,
} from "class-validator";

/**
 * Request body for creating a note
 */
export class NotePostRequest {
  @IsBase64()
  @IsNotEmpty()
  ciphertext: string | undefined;

  @IsBase64()
  @IsNotEmpty()
  hmac: string | undefined;

  @ValidateIf((o) => o.user_id != null)
  @IsHexadecimal()
  user_id: string | undefined;

  @ValidateIf((o) => o.plugin_version != null)
  @Matches("^[0-9]+\\.[0-9]+\\.[0-9]+$")
  plugin_version: string | undefined;

  @Matches("^v[0-9]+$")
  crypto_version: string = "v1";
}

export async function postNoteController(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const event: WriteEvent = {
    success: false,
    host: getConnectingIp(req),
    user_id: req.body.user_id,
    user_plugin_version: req.body.plugin_version,
  };

  // Validate request body
  const notePostRequest = new NotePostRequest();
  Object.assign(notePostRequest, req.body);
  try {
    await validateOrReject(notePostRequest);
  } catch (_err: any) {
    const err = _err as ValidationError;
    res.status(400).send(err.toString());
    event.error = err.toString();
    EventLogger.writeEvent(event);
    return;
  }

  // Validate user ID, if present
  if (notePostRequest.user_id && !checkId(notePostRequest.user_id)) {
    console.log("invalid user id");
    res.status(400).send("Invalid user id (checksum failed)");
    event.error = "Invalid user id (checksum failed)";
    EventLogger.writeEvent(event);
    return;
  }

  // Create note object
  const EXPIRE_WINDOW_DAYS = 30;
  const note = {
    ciphertext: notePostRequest.ciphertext as string,
    hmac: notePostRequest.hmac as string,
    expire_time: addDays(new Date(), EXPIRE_WINDOW_DAYS),
    crypto_version: notePostRequest.crypto_version,
  } as EncryptedNote;

  // Store note object
  createNote(note)
    .then(async (savedNote) => {
      event.success = true;
      event.note_id = savedNote.id;
      event.size_bytes = savedNote.ciphertext.length + savedNote.hmac.length;
      event.expire_window_days = EXPIRE_WINDOW_DAYS;
      await EventLogger.writeEvent(event);
      res.json({
        view_url: `${process.env.FRONTEND_URL}/note/${savedNote.id}`,
        expire_time: savedNote.expire_time,
      });
    })
    .catch(async (err) => {
      event.error = err.toString();
      await EventLogger.writeEvent(event);
      next(err);
    });
}

/**
 * @param id {string} a 16 character base16 string with 12 random characters and 4 CRC characters
 * @returns {boolean} true if the id is valid, false otherwise
 */
function checkId(id: string): boolean {
  // check length
  if (id.length !== 16) {
    return false;
  }
  // extract the random number and the checksum
  const random = id.slice(0, 12);
  const checksum = id.slice(12, 16);

  // compute the CRC of the random number
  const computedChecksum = crc(random).toString(16).padStart(4, "0");

  // compare the computed checksum with the one in the id
  return computedChecksum === checksum;
}