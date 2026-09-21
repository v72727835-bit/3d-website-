"""Smooth the CC0 Quaternius horse while preserving its authored skin/animation.

Usage: python scripts/refine-horse.py SOURCE.glb OUTPUT.glb
Requires numpy. Uses two Loop subdivision passes, carries joint influences
through the same stencils, then retains the strongest four per vertex.
"""
import json
import struct
import sys
from pathlib import Path
import numpy as np

source, target = map(Path, sys.argv[1:3])
blob = source.read_bytes()
json_length = struct.unpack_from('<I', blob, 12)[0]
doc = json.loads(blob[20:20+json_length])
raw = bytearray(blob[28+json_length:])

def read(index):
    acc = doc['accessors'][index]
    view = doc['bufferViews'][acc['bufferView']]
    dt = {5126:'<f4',5125:'<u4',5123:'<u2',5121:'u1'}[acc['componentType']]
    width = {'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4,'MAT4':16}[acc['type']]
    return np.frombuffer(raw, dtype=dt, count=acc['count']*width,
        offset=view.get('byteOffset',0)+acc.get('byteOffset',0)).reshape(-1,width).copy()

primitives = doc['meshes'][0]['primitives']
joint_count = len(doc['skins'][0]['joints'])
unique, positions, skin, faces, materials = {}, [], [], [], []
for primitive in primitives:
    at = primitive['attributes']
    p, joints, weights = read(at['POSITION']), read(at['JOINTS_0']), read(at['WEIGHTS_0'])
    remap = []
    for i, pos in enumerate(p):
        key = tuple(np.round(pos,8))
        if key not in unique:
            unique[key] = len(positions)
            positions.append(pos)
            influence = np.zeros(joint_count)
            for bone, weight in zip(joints[i],weights[i]): influence[int(bone)] += weight
            skin.append(influence)
        remap.append(unique[key])
    triangles = np.array(remap)[read(primitive['indices']).reshape(-1,3)]
    faces.extend(triangles)
    materials.extend([primitive['material']]*len(triangles))
data = np.concatenate([np.array(positions),np.array(skin)],axis=1)
faces, materials = np.array(faces), np.array(materials)

for level in range(2):
    count = len(data)
    neighbours = [set() for _ in range(count)]
    edges = {}
    for a,b,c in faces:
        for x,y,z in [(a,b,c),(b,c,a),(c,a,b)]:
            neighbours[x].add(y); neighbours[y].add(x)
            edges.setdefault(tuple(sorted((x,y))),[]).append(z)
    border = [[] for _ in range(count)]
    for (a,b),opposite in edges.items():
        if len(opposite)==1: border[a].append(b); border[b].append(a)
    refined = np.zeros((count+len(edges),data.shape[1]))
    for i, adjacent in enumerate(neighbours):
        k=len(adjacent)
        if len(border[i])==2:
            refined[i]=data[i]*.75+data[border[i]].sum(axis=0)*.125
        elif k:
            beta=3/16 if k==3 else 3/(8*k)
            refined[i]=data[i]*(1-k*beta)+data[list(adjacent)].sum(axis=0)*beta
        else: refined[i]=data[i]
    edge_index={}
    for offset,((a,b),opposite) in enumerate(edges.items()):
        ix=count+offset; edge_index[(a,b)]=ix
        refined[ix]=(data[a]+data[b])*.375+data[opposite].sum(axis=0)*.125 if len(opposite)==2 else (data[a]+data[b])*.5
    new_faces=[]
    for a,b,c in faces:
        ab=edge_index[tuple(sorted((a,b)))]; bc=edge_index[tuple(sorted((b,c)))]; ca=edge_index[tuple(sorted((c,a)))]
        new_faces.extend([(a,ab,ca),(b,bc,ab),(c,ca,bc),(ab,bc,ca)])
    data=refined; faces=np.array(new_faces); materials=np.repeat(materials,4)

positions=data[:,:3].astype('float32')
weights=data[:,3:]
joints=np.argsort(weights,axis=1)[:,-4:]
weights=np.take_along_axis(weights,joints,axis=1)
weights/=np.maximum(weights.sum(axis=1,keepdims=True),1e-8)
normals=np.zeros_like(positions)
face_normals=np.cross(positions[faces[:,1]]-positions[faces[:,0]],positions[faces[:,2]]-positions[faces[:,0]])
for axis in range(3):np.add.at(normals,faces[:,axis],face_normals)
normals/=np.maximum(np.linalg.norm(normals,axis=1,keepdims=True),1e-12)
# Planar UVs let the existing micro-fur material vary over the coat.
uv=(positions[:,[1,2]]-positions[:,[1,2]].min(axis=0))/np.maximum(np.ptp(positions[:,[1,2]],axis=0),1e-6)

def append(array,kind,component=5126):
    while len(raw)%4: raw.append(0)
    array=np.ascontiguousarray(array,dtype={5126:'<f4',5125:'<u4',5123:'<u2'}[component])
    view=len(doc['bufferViews'])
    doc['bufferViews'].append({'buffer':0,'byteOffset':len(raw),'byteLength':array.nbytes})
    raw.extend(array.tobytes())
    acc={'bufferView':view,'componentType':component,'count':len(array),'type':kind}
    if component==5126:acc.update(min=array.min(axis=0).tolist(),max=array.max(axis=0).tolist())
    doc['accessors'].append(acc)
    return len(doc['accessors'])-1

attributes={'POSITION':append(positions,'VEC3'),'NORMAL':append(normals,'VEC3'),
    'TEXCOORD_0':append(uv,'VEC2'),'JOINTS_0':append(joints,'VEC4',5123),'WEIGHTS_0':append(weights,'VEC4')}
for primitive in primitives:
    primitive['attributes']=attributes
    primitive['indices']=append(faces[materials==primitive['material']].reshape(-1,1),'SCALAR',5125)
doc['asset']['extras']={'source':'https://poly.pizza/m/qvTrSG9pZF','author':'Quaternius','license':'CC0-1.0','modification':'Two Loop subdivisions with interpolated skin weights, smooth normals and coat UVs'}
doc['buffers'][0]['byteLength']=len(raw)
encoded=json.dumps(doc,separators=(',',':')).encode()
encoded+=b' '*((-len(encoded))%4);raw+=b'\0'*((-len(raw))%4)
target.write_bytes(struct.pack('<III',0x46546c67,2,28+len(encoded)+len(raw))+struct.pack('<II',len(encoded),0x4e4f534a)+encoded+struct.pack('<II',len(raw),0x004e4942)+raw)
print(f'{len(positions)} vertices / {len(faces)} triangles; skin weights normalised; {target.stat().st_size} bytes')
