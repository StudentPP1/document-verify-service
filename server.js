import express from 'express';
import multer from 'multer';
import fs from 'fs';
import cors from 'cors';
import { FaceSdk, ImageSource } from '@regulaforensics/facesdk-webclient';
import {
    DocumentReaderApi,
    Scenario,
    Light,
    Source,
    GraphicFieldType,
} from '@regulaforensics/document-reader-webclient';

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;
const DOC_READER_URL = (process.env.DOC_READER_URL || 'http://localhost:8080').replace(/\/$/, '');
const FACE_SDK_URL = process.env.FACE_SDK_URL || 'http://localhost:41101';

const faceSdk = new FaceSdk({ basePath: FACE_SDK_URL });
const docApi = new DocumentReaderApi({ basePath: DOC_READER_URL });

const cleanupFiles = (files) => {
    files.forEach(path => {
        if (fs.existsSync(path)) fs.unlinkSync(path);
    });
};

app.post('/api/verify', upload.fields([{ name: 'passport' }, { name: 'selfie' }]), async (req, res) => {
    const { passport, selfie } = req.files || {};
    const cleanupList = [];

    if (passport?.[0]) cleanupList.push(passport[0].path);
    if (selfie?.[0]) cleanupList.push(selfie[0].path);

    if (!passport || !selfie) {
        cleanupFiles(cleanupList);
        return res.status(400).json({ error: 'Passport and selfie files are required' });
    }

    try {
        console.log(`[INFO] Processing: ${passport[0].originalname} (Passport) & ${selfie[0].originalname} (Selfie)`);

        const passportBuffer = fs.readFileSync(passport[0].path);
        const selfieBase64 = fs.readFileSync(selfie[0].path).toString('base64');

        console.log('[INFO] Sending to Document Reader...');
        
        const docResponse = await docApi.process({
            images: [
                {
                    ImageData: passportBuffer,
                    light: Light.WHITE,
                    page_idx: 0,
                },
            ],
            processParam: {
                scenario: Scenario.FULL_PROCESS,
                alreadyCropped: false, 
            },
        });

        const portraitField = docResponse.images.getField(GraphicFieldType.PORTRAIT);
        if (!portraitField) {
            console.error('[ERROR] Portrait not found in document');
            return res.json({ success: false, reason: 'PORTRAIT_NOT_FOUND' });
        }

        const portraitDataArray = portraitField.getValue(Source.VISUAL) || portraitField.getValue(Source.RFID);
        if (!portraitDataArray) {
             console.error('[ERROR] Portrait data is empty');
             return res.json({ success: false, reason: 'PORTRAIT_DATA_EMPTY' });
        }

        const docFaceBase64 = Buffer.from(portraitDataArray).toString('base64');
        const docName = docResponse.documentType()?.DocumentName || 'UNKNOWN';
        console.log(`[INFO] Document processed: ${docName}`);
        console.log(`[DEBUG] DocFace Size: ${docFaceBase64.length} chars | Selfie Size: ${selfieBase64.length} chars`);

        console.log('[INFO] Matching faces...');
        if (!docFaceBase64 || docFaceBase64.length === 0) {
            throw new Error('Portrait extraction failed: no face data from document');
        }
        if (!selfieBase64 || selfieBase64.length === 0) {
            throw new Error('Selfie processing failed: no valid image data');
        }
        
        const matchResponse = await faceSdk.matchingApi.match({
            images: [
                {
                    type: ImageSource.DOCUMENT_PRINT,
                    data: docFaceBase64,
                    index: 1
                },
                {
                    type: ImageSource.LIVE,
                    data: selfieBase64,
                    index: 2
                }
            ]
        });

        console.log('[DEBUG] Face SDK Response:', JSON.stringify(matchResponse, null, 2).substring(0, 500));

        const results = matchResponse.results;
        if (!results || results.length === 0) {
            console.error('[ERROR] Face SDK returned 0 results. Check if images contain faces.');
            console.error('[DEBUG] Full response structure:', JSON.stringify(matchResponse, null, 2));
            throw new Error("No match results returned from Face SDK");
        }
        
        const matchResult = results[0];
        if (!matchResult.similarity && matchResult.similarity !== 0) {
            console.error('[ERROR] No similarity score in Face SDK response');
            throw new Error("Invalid Face SDK response: missing similarity score");
        }

        const similarity = matchResult.similarity * 100;
        console.log(`[INFO] Similarity: ${similarity.toFixed(2)}%`);

        const isMatch = similarity > 75;

        res.json({
            success: isMatch,
            verificationStatus: isMatch ? 'VERIFIED' : 'REJECTED',
            similarity: parseFloat(similarity.toFixed(2)),
            docType: docName,
            details: { documentValid: true, faceMatch: isMatch }
        });

    } catch (error) {
        console.error('[ERROR] Processing failed:', error.message);
        console.error('[ERROR] Stack trace:', error.stack);
        if (error.response) {
            console.error('[DEBUG] API Status:', error.response.status);
            console.error('[DEBUG] API Error Details:', JSON.stringify(error.response.data, null, 2));
        }
        const statusCode = error.response?.status || 500;
        res.status(statusCode).json({ 
            success: false,
            error: 'Processing failed', 
            details: error.message,
            reason: error.message.includes('No match') ? 'NO_FACES_DETECTED' : 'PROCESSING_ERROR'
        });
    } finally {
        cleanupFiles(cleanupList);
    }
});

app.listen(PORT, () => console.log(`[INFO] Server running on port ${PORT}`));