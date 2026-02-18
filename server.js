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
    TextFieldType,
    Result
} from '@regulaforensics/document-reader-webclient';
import 'dotenv/config';

const { DOCUMENT_NUMBER, SURNAME_AND_GIVEN_NAMES, DATE_OF_BIRTH, DATE_OF_EXPIRY } = TextFieldType;
const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;
const DOC_READER_URL = process.env.DOC_READER_URL;
const FACE_SDK_URL = process.env.FACE_SDK_URL;

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
        console.log(`[INFO] Processing: ${passport[0].originalname} & ${selfie[0].originalname}`);

        const passportBuffer = fs.readFileSync(passport[0].path).buffer;
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

        const getFieldVal = (type) => {
            const field = docResponse.text?.getField(type);
            return field ? field.value : null;
        };
        
        let docType = docResponse.documentType()?.DocumentName;
        if (!docType || docType.trim() === '') {
            docType = 'UNKNOWN';
        }

        const docData = {
            number: getFieldVal(DOCUMENT_NUMBER),
            name: getFieldVal(SURNAME_AND_GIVEN_NAMES),
            dob: getFieldVal(DATE_OF_BIRTH),
            expiry: getFieldVal(DATE_OF_EXPIRY),
            type: docType
        };

        const overallStatus = docResponse.status.overallStatus;
        const docErrors = [];

        if (docType === 'UNKNOWN') {
            docErrors.push("Document type NOT recognized (Unknown document)");
        }
        if (overallStatus === Result.ERROR) {
            docErrors.push("Critical Error: Document validation failed");
        }
        let isExpiredManual = false;
        if (docData.expiry) {
            const expiryDate = new Date(docData.expiry);
            const today = new Date();
            today.setHours(0,0,0,0);
            
            if (expiryDate < today) {
                isExpiredManual = true;
                docErrors.push(`Document is EXPIRED (Valid until: ${docData.expiry})`);
            }
        } else {
            if (docType === 'UNKNOWN') docErrors.push("No expiry date found on unknown document");
        }
        if (!docData.number && !docData.name) {
            docErrors.push("No text data extracted (Image too blurry or empty)");
        }

        const isDocumentValid = docErrors.length === 0;

        console.log(`[DEBUG] Report:`);
        console.log(`Type: ${docType}`);
        console.log(`Overall Status: ${overallStatus}`);
        console.log(`Manual Expiry Check: ${isExpiredManual ? 'FAIL' : 'PASS'}`);
        console.log(`Errors: ${docErrors.length}`);
        console.log(`FINAL DECISION: ${isDocumentValid ? 'VALID' : 'INVALID'}`);

        const portraitField = docResponse.images.getField(GraphicFieldType.PORTRAIT);
        let docFaceBase64 = null;
        if (portraitField) {
            const portraitDataArray = portraitField.getValue(Source.VISUAL) || portraitField.getValue(Source.RFID);
            if(portraitDataArray) docFaceBase64 = Buffer.from(portraitDataArray).toString('base64');
        }

        if (!docFaceBase64) {
            console.error('[ERROR] No face found in document');
            res.json({
                success: false,
                verificationStatus: 'REJECTED',
                checks: {
                    faceMatch: { passed: false, error: 'No face in document' },
                    documentValidation: { passed: isDocumentValid, errors: [...docErrors, "No face found"] }
                },
                data: docData
            });
            return;
        }

        console.log('[INFO] Matching faces...');
        
        const matchResponse = await faceSdk.matchApi.match({
            images: [
                { type: ImageSource.DOCUMENT_PRINT, data: docFaceBase64, index: 1 },
                { type: ImageSource.LIVE, data: selfieBase64, index: 2 }
            ]
        });

        const results = matchResponse.results || matchResponse.Results;
        if (!results || results.length === 0) throw new Error("No match results");

        const similarity = results[0].similarity * 100;
        console.log(`[INFO] Similarity: ${similarity.toFixed(2)}%`);
        const isFaceMatch = similarity > 75;

        res.json({
            success: isFaceMatch && isDocumentValid,
            verificationStatus: (isFaceMatch && isDocumentValid) ? 'VERIFIED' : 'REJECTED',
            checks: {
                faceMatch: {
                    passed: isFaceMatch,
                    similarity: parseFloat(similarity.toFixed(2))
                },
                documentValidation: {
                    passed: isDocumentValid,
                    status: overallStatus, 
                    errors: docErrors
                }
            },
            data: docData
        });

    } catch (error) {
        console.error('[ERROR] Processing failed:', error.message);
        res.status(500).json({ success: false, error: error.message });
    } finally {
        cleanupFiles(cleanupList);
    }
});

app.listen(PORT, () => console.log(`[INFO] Server running on port ${PORT}`));